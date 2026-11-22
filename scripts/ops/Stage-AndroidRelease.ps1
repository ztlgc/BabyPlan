#Requires -Version 7.0
[CmdletBinding(DefaultParameterSetName = 'Repository')]
param(
  [Parameter(Mandatory)]
  [ValidatePattern('^\d+\.\d+\.\d+$')]
  [string]$PreviousVersion,

  [Parameter(ParameterSetName = 'Explicit', Mandatory)]
  [ValidatePattern('^\d+\.\d+\.\d+$')]
  [string]$Version,

  [Parameter(ParameterSetName = 'Explicit', Mandatory)]
  [ValidateRange(1, 2100000000)]
  [int]$VersionCode,

  [Parameter(ParameterSetName = 'Explicit', Mandatory)]
  [Parameter(ParameterSetName = 'Repository')]
  [string]$OutputRoot,

  [string]$ReleaseApk,
  [string]$DebugApk,
  [string]$PublicCertificate,
  [string]$BuildToolsDirectory
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repository = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).ProviderPath
$utf8 = [System.Text.UTF8Encoding]::new($false)
$appId = 'app.babyplan.babyplan'
$certificateName = 'babyplan-signing-certificate.pem'

function Get-FileSha256([string]$Path) {
  (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-InputFile([string]$Path) {
  $item = Get-Item -LiteralPath $Path -ErrorAction Stop
  if ($item -isnot [IO.FileInfo] -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw "输入必须是普通文件：$Path"
  }
  return $item
}

function Resolve-BuildTools {
  if ($BuildToolsDirectory) {
    $directories = @($BuildToolsDirectory)
  } else {
    $directories = foreach ($sdk in @($env:ANDROID_HOME, $env:ANDROID_SDK_ROOT, (Join-Path $env:LOCALAPPDATA 'Android/Sdk'))) {
      if (-not $sdk) { continue }
      $tools = Join-Path $sdk 'build-tools'
      if (Test-Path -LiteralPath $tools -PathType Container) {
        Get-ChildItem -LiteralPath $tools -Directory |
          Where-Object { $_.Name -match '^\d+\.\d+\.\d+$' } |
          Sort-Object -Property @{ Expression = { $_.Name -eq '36.0.0' }; Descending = $true }, @{ Expression = { [version]$_.Name }; Descending = $true } |
          ForEach-Object FullName
      }
    }
  }
  foreach ($directory in $directories) {
    $aapt2 = Join-Path $directory 'aapt2.exe'
    $signer = Join-Path $directory 'apksigner.bat'
    if ((Test-Path -LiteralPath $aapt2 -PathType Leaf) -and (Test-Path -LiteralPath $signer -PathType Leaf)) {
      return @{ Aapt2 = $aapt2; Signer = $signer }
    }
  }
  throw '未找到同一 SDK build-tools 目录中的 aapt2.exe 和 apksigner.bat。'
}

function Read-ToolOutput([string]$Executable, [string[]]$Arguments, [string]$ErrorMessage) {
  $output = @(& $Executable @Arguments 2>&1)
  if ($LASTEXITCODE -ne 0 -or $output.Count -eq 0) { throw $ErrorMessage }
  return $output
}

function Read-Signature([hashtable]$Tools, [IO.FileInfo]$Apk) {
  $output = @(Read-ToolOutput $Tools.Signer @('verify', '--verbose', '--print-certs', $Apk.FullName) "APK 验签失败：$($Apk.Name)")
  $text = $output -join [Environment]::NewLine
  if ($text -notmatch 'Verified using v2 scheme \(APK Signature Scheme v2\): true' -or
      $text -notmatch '(?m)^Number of signers:\s*1\s*$' -or
      $text -notmatch '(?m)^Signer #1 certificate SHA-256 digest:\s*(?<sha>[0-9a-fA-F]{64})\s*$') {
    throw "APK 必须以单一证书通过 v2 签名验证：$($Apk.Name)"
  }
  return @{ Fingerprint = $Matches.sha.ToLowerInvariant(); Evidence = $output }
}

function Read-Badging([hashtable]$Tools, [IO.FileInfo]$Apk) {
  $output = @(Read-ToolOutput $Tools.Aapt2 @('dump', 'badging', $Apk.FullName) "无法读取 APK 包信息：$($Apk.Name)")
  if ($output[0] -notmatch "^package: name='(?<id>[a-zA-Z0-9_.]+)' versionCode='(?<code>\d+)' versionName='(?<name>[^']+)'") {
    throw "APK 缺少包名或版本：$($Apk.Name)"
  }
  $metadata = @{ Id = $Matches.id; Code = [int]$Matches.code; Name = $Matches.name; Evidence = $output }
  $text = $output -join [Environment]::NewLine
  if ($text -notmatch "(?m)^minSdkVersion:'(?<min>\d+)'") { throw "APK 缺少 minSdk：$($Apk.Name)" }
  $metadata.MinSdk = [int]$Matches.min
  if ($text -notmatch "(?m)^targetSdkVersion:'(?<target>\d+)'") { throw "APK 缺少 targetSdk：$($Apk.Name)" }
  $metadata.TargetSdk = [int]$Matches.target
  if ($output[0] -notmatch "compileSdkVersion='(?<compile>\d+)'") { throw "APK 缺少 compileSdk：$($Apk.Name)" }
  $metadata.CompileSdk = [int]$Matches.compile
  return $metadata
}

function Assert-NetworkPolicy([hashtable]$Tools, [IO.FileInfo]$Apk, [bool]$IsDebug) {
  $output = @(Read-ToolOutput $Tools.Aapt2 @('dump', 'xmltree', '--file', 'AndroidManifest.xml', $Apk.FullName) "无法读取 Android 清单：$($Apk.Name)")
  $text = $output -join [Environment]::NewLine
  if ($text -notmatch "(?m)android:usesCleartextTraffic\([^)]*\)=true\s*$" -or
      (($text -match '(?m)android:debuggable\([^)]*\)=true\s*$') -ne $IsDebug)) {
    throw "APK 的网络或调试策略不符：$($Apk.Name)"
  }
}

if ($PSCmdlet.ParameterSetName -eq 'Repository') {
  $pubspec = [IO.File]::ReadAllText((Join-Path $repository 'apps/mobile/pubspec.yaml'))
  if ($pubspec -notmatch '(?m)^version:\s*(?<version>\d+\.\d+\.\d+)\+(?<code>\d+)\s*$') {
    throw 'Flutter 版本必须同时包含版本名和版本码。'
  }
  $Version = $Matches.version
  $VersionCode = [int]$Matches.code
}
if ([version]$Version -le [version]$PreviousVersion) {
  throw '目标版本必须高于用于核对覆盖安装的旧版本。'
}
if (-not $OutputRoot) { $OutputRoot = Join-Path $repository 'releases' }
$resolvedOutputRoot = [IO.Path]::GetFullPath($OutputRoot, (Get-Location).ProviderPath)
$destination = Join-Path $resolvedOutputRoot "v$Version"
if (Test-Path -LiteralPath $destination) { throw "发布目录已存在，未改动任何文件：$destination" }

$oldDirectory = Join-Path $repository "releases/v$PreviousVersion"
$oldManifest = [IO.File]::ReadAllText((Get-InputFile (Join-Path $oldDirectory 'manifest.json')).FullName) | ConvertFrom-Json
if ($oldManifest.version -ne $PreviousVersion -or $VersionCode -le [int]$oldManifest.versionCode) {
  throw '目标 APK 的版本码必须高于旧版安装包。'
}

if (-not $PublicCertificate) { $PublicCertificate = Join-Path $oldDirectory $certificateName }
$publicPem = Get-InputFile $PublicCertificate
$pemText = [IO.File]::ReadAllText($publicPem.FullName)
# 只接收一份公开证书。即使传错文件，也不会复制包含私钥、额外 PEM 块的输入。
if ($pemText -cnotmatch '\A\s*-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\s*\z') {
  throw '必须提供只含一份公开证书的 PEM。'
}
$certificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::CreateFromPem($pemText)
try {
  $certificateFingerprint = $certificate.GetCertHashString([System.Security.Cryptography.HashAlgorithmName]::SHA256).ToLowerInvariant()
} finally {
  $certificate.Dispose()
}
if ($certificateFingerprint -ne $oldManifest.releaseCertificateSha256) {
  throw '公开证书与旧版正式 APK 的发布证书不一致。'
}
$certificateSha = Get-FileSha256 $publicPem.FullName

$buildOutput = Join-Path $repository 'apps/mobile/build/app/outputs/flutter-apk'
if (-not $ReleaseApk) { $ReleaseApk = Join-Path $buildOutput 'app-release.apk' }
if (-not $DebugApk) { $DebugApk = Join-Path $buildOutput 'app-debug.apk' }
$tools = Resolve-BuildTools
$variants = [ordered]@{
  'private-release' = @{ Source = $ReleaseApk; Id = $appId; VersionSuffix = ''; IsDebug = $false; Network = 'HTTP or HTTPS'; Purpose = '长期私人使用；支持可信局域网 HTTP 或 HTTPS 家庭服务' }
  'lan-debug' = @{ Source = $DebugApk; Id = "$appId.dev"; VersionSuffix = '-dev'; IsDebug = $true; Network = 'HTTP LAN or HTTPS'; Purpose = '同一局域网首次试用；不能替代正式发布签名' }
}
$variantManifest = foreach ($variantName in $variants.Keys) {
  $variant = $variants[$variantName]
  $oldName = "BabyPlan_$($PreviousVersion)_$variantName.apk"
  $oldApk = Get-InputFile (Join-Path $oldDirectory $oldName)
  $oldVariant = @($oldManifest.variants | Where-Object { $_.name -eq $variantName })
  if ($oldVariant.Count -ne 1 -or $oldVariant[0].file -ne $oldName -or
      $oldVariant[0].applicationId -ne $variant.Id -or (Get-FileSha256 $oldApk.FullName) -ne $oldVariant[0].sha256) {
    throw "旧版安装包与清单不一致：$oldName"
  }
  $oldMetadata = Read-Badging $tools $oldApk
  $oldSignature = Read-Signature $tools $oldApk
  if ($oldMetadata.Id -ne $variant.Id -or $oldMetadata.Code -ne [int]$oldManifest.versionCode -or
      $oldMetadata.Name -ne "$PreviousVersion$($variant.VersionSuffix)") {
    throw "旧版安装包的包名或版本与清单不一致：$oldName"
  }
  $source = Get-InputFile $variant.Source
  $variant.File = "BabyPlan_$($Version)_$variantName.apk"
  $variant.Source = $source.FullName
  $variant.Sha256 = Get-FileSha256 $source.FullName
  $variant.Metadata = Read-Badging $tools $source
  $variant.Signature = Read-Signature $tools $source
  if ($variant.Metadata.Id -ne $variant.Id -or $variant.Metadata.Code -ne $VersionCode -or
      $variant.Metadata.Name -ne "$Version$($variant.VersionSuffix)") {
    throw "新安装包的包名或版本不符合发布要求：$($source.Name)"
  }
  if ($variant.Signature.Fingerprint -ne $oldSignature.Fingerprint -or
      (-not $variant.IsDebug -and $variant.Signature.Fingerprint -ne $certificateFingerprint)) {
    throw "安装包签名与旧版不一致，无法覆盖升级：$variantName"
  }
  Assert-NetworkPolicy $tools $source $variant.IsDebug
  [ordered]@{
    name = $variantName
    file = $variant.File
    bytes = $source.Length
    sha256 = $variant.Sha256
    applicationId = $variant.Id
    signature = if ($variant.IsDebug) { 'Android debug v2' } else { 'v2' }
    certificateSha256 = $variant.Signature.Fingerprint
    network = $variant.Network
    purpose = $variant.Purpose
  }
}
$release = $variants['private-release']
$debug = $variants['lan-debug']
foreach ($field in @('MinSdk', 'TargetSdk', 'CompileSdk')) {
  if ($release.Metadata[$field] -ne $debug.Metadata[$field]) { throw "两个安装包的 $field 不一致。" }
}
$content = [IO.File]::ReadAllText((Join-Path $repository 'content/candidate/babyplan-18-23-v2.json')) | ConvertFrom-Json
$manifest = [ordered]@{
  product = 'BabyPlan 小芽'
  version = $Version
  versionCode = $VersionCode
  builtOn = (Get-Date).ToString('yyyy-MM-dd')
  variants = @($variantManifest)
  releaseCertificateSha256 = $certificateFingerprint
  certificateFileSha256 = $certificateSha
  minSdk = $release.Metadata.MinSdk
  targetSdk = $release.Metadata.TargetSdk
  compileSdk = $release.Metadata.CompileSdk
  contentPackage = $content.packageId
  contentVersion = $content.contentVersion
  contentReview = 'candidate/draft; not human reviewed'
  verified = @('APK Signature Scheme v2; both signers match prior build',
    "Same-variant package identifiers and version codes verified against $PreviousVersion",
    'aapt2 badging, manifest network policy, and SHA-256')
  unverified = @('real Android device', 'notification delivery', 'photo picker',
    'two-device sync', 'public HTTPS deployment', 'on-device in-place update')
}

[IO.Directory]::CreateDirectory($resolvedOutputRoot) | Out-Null
$staging = Join-Path $resolvedOutputRoot ('.android-stage-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($staging) | Out-Null
$stagedNames = @($release.File, $debug.File, $certificateName, 'release-signature-verification.txt',
  'release-badging.txt', 'debug-signature-verification.txt', 'debug-badging.txt',
  'manifest.json', 'SHA256SUMS.txt')
try {
  foreach ($variant in $variants.Values) {
    $target = Join-Path $staging $variant.File
    [IO.File]::Copy($variant.Source, $target)
    if ((Get-FileSha256 $target) -ne $variant.Sha256) { throw "APK 在暂存期间发生变化：$($variant.File)" }
  }
  $stagedCertificate = Join-Path $staging $certificateName
  [IO.File]::Copy($publicPem.FullName, $stagedCertificate)
  if ((Get-FileSha256 $stagedCertificate) -ne $certificateSha) { throw '公开证书在暂存期间发生变化。' }
  [IO.File]::WriteAllLines((Join-Path $staging 'release-signature-verification.txt'), [string[]]$release.Signature.Evidence, $utf8)
  [IO.File]::WriteAllLines((Join-Path $staging 'release-badging.txt'), [string[]]$release.Metadata.Evidence, $utf8)
  [IO.File]::WriteAllLines((Join-Path $staging 'debug-signature-verification.txt'), [string[]]$debug.Signature.Evidence, $utf8)
  [IO.File]::WriteAllLines((Join-Path $staging 'debug-badging.txt'), [string[]]$debug.Metadata.Evidence, $utf8)
  $hashes = @($variants.Values | ForEach-Object { "$($_.Sha256)  $($_.File)" }) + "$certificateSha  $certificateName"
  [IO.File]::WriteAllLines((Join-Path $staging 'SHA256SUMS.txt'), [string[]]$hashes, $utf8)
  [IO.File]::WriteAllText((Join-Path $staging 'manifest.json'), (($manifest | ConvertTo-Json -Depth 8) + [Environment]::NewLine), $utf8)
  # 不覆盖已存在目录。APK、证书和证据作为完整版本目录一起出现。
  [IO.Directory]::Move($staging, $destination)
} finally {
  if ([IO.Directory]::Exists($staging)) {
    foreach ($name in $stagedNames) { [IO.File]::Delete((Join-Path $staging $name)) }
    [IO.Directory]::Delete($staging)
  }
}

Write-Host "已暂存 BabyPlan $Version（版本码 $VersionCode）：$destination"
Write-Host "两个版本均通过 v2 签名与版本核对，具备覆盖 $PreviousVersion 同类型安装包的静态条件。"

