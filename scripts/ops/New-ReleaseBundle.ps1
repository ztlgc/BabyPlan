[CmdletBinding()]
param(
  [ValidatePattern('^\d+\.\d+\.\d+$')]
  [string]$Version,
  [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
if (-not $Version) {
  $pubspec = Get-Content -Raw -LiteralPath (Join-Path $repositoryRoot 'apps/mobile/pubspec.yaml')
  if ($pubspec -notmatch '(?m)^version:\s*(\d+\.\d+\.\d+)\+\d+') { throw '无法读取 Flutter 版本。' }
  $Version = $Matches[1]
}
$releaseRoot = Join-Path $repositoryRoot "releases/v$Version"
$outputPath = Join-Path $releaseRoot "BabyPlan-$Version-delivery.zip"
$partialPath = "$outputPath.partial"
$bundleRoot = "BabyPlan-$Version"
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)

function Assert-NoReparsePointInPath {
  param(
    [Parameter(Mandatory)]
    [string]$Path
  )

  $current = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  while ($current) {
    if (
      ($current.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne
        0
    ) {
      throw "拒绝打包包含符号链接或目录联接的路径：$($current.FullName)"
    }
    if (
      $current.FullName.Equals(
        $repositoryRoot,
        [StringComparison]::OrdinalIgnoreCase
      )
    ) {
      break
    }
    if (
      ($current.Attributes -band [System.IO.FileAttributes]::Directory) -ne 0
    ) {
      $current = $current.Parent
    } else {
      $current = $current.Directory
    }
  }
}

function Get-RequiredFile {
  param(
    [Parameter(Mandatory)]
    [string]$Path
  )

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "交付文件缺失：$Path"
  }
  Assert-NoReparsePointInPath -Path $Path
  return Get-Item -LiteralPath $Path
}

function Read-Checksums {
  param(
    [Parameter(Mandatory)]
    [string]$Path
  )

  $entries = @{}
  foreach ($line in Get-Content -LiteralPath $Path -Encoding UTF8) {
    if (-not $line.Trim()) {
      continue
    }
    if ($line -notmatch '^([0-9A-Fa-f]{64})[ \t]+\*?([^/\\]+)$') {
      throw "SHA256SUMS.txt 格式无效：$line"
    }
    $name = $Matches[2]
    if ($entries.ContainsKey($name)) {
      throw "SHA256SUMS.txt 含重复文件：$name"
    }
    $entries[$name] = $Matches[1].ToLowerInvariant()
  }
  return ,$entries
}

function Resolve-ApkSigner {
  $command = Get-Command 'apksigner.bat' -CommandType Application -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($command) {
    return $command.Source
  }
  $sdkRoots = @(
    $env:ANDROID_HOME
    $env:ANDROID_SDK_ROOT
    (Join-Path $env:LOCALAPPDATA 'Android/Sdk')
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Container) }
  foreach ($sdkRoot in $sdkRoots) {
    $candidate = Get-ChildItem `
      -LiteralPath (Join-Path $sdkRoot 'build-tools') `
      -Directory `
      -ErrorAction SilentlyContinue |
      Sort-Object {
        $parsed = [version]'0.0'
        [void][version]::TryParse($_.Name, [ref]$parsed)
        $parsed
      } -Descending |
      ForEach-Object { Join-Path $_.FullName 'apksigner.bat' } |
      Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
      Select-Object -First 1
    if ($candidate) {
      return $candidate
    }
  }
  throw '找不到 apksigner.bat，无法在打包前复核正式 APK 签名。'
}

function Write-ZipTextEntry {
  param(
    [Parameter(Mandatory)]
    [System.IO.Compression.ZipArchive]$Archive,
    [Parameter(Mandatory)]
    [string]$EntryName,
    [Parameter(Mandatory)]
    [string]$Text
  )

  $entry = $Archive.CreateEntry(
    $EntryName,
    [System.IO.Compression.CompressionLevel]::Optimal
  )
  $stream = $entry.Open()
  try {
    $writer = [System.IO.StreamWriter]::new(
      $stream,
      $utf8NoBom,
      1024,
      $true
    )
    try {
      $writer.Write($Text)
    }
    finally {
      $writer.Dispose()
    }
  }
  finally {
    $stream.Dispose()
  }
}

function Add-FileToZip {
  param(
    [Parameter(Mandatory)]
    [System.IO.Compression.ZipArchive]$Archive,
    [Parameter(Mandatory)]
    [System.IO.FileInfo]$Source,
    [Parameter(Mandatory)]
    [string]$EntryName
  )

  $entry = $Archive.CreateEntry(
    "$bundleRoot/$EntryName",
    [System.IO.Compression.CompressionLevel]::Optimal
  )
  $entry.LastWriteTime = $Source.LastWriteTime
  $input = [System.IO.File]::OpenRead($Source.FullName)
  $output = $entry.Open()
  try {
    $input.CopyTo($output)
  }
  finally {
    $output.Dispose()
    $input.Dispose()
  }
}

if (-not (Test-Path -LiteralPath $releaseRoot -PathType Container)) {
  throw "发布目录不存在：$releaseRoot"
}
if ((Test-Path -LiteralPath $outputPath) -and -not $Force) {
  throw "交付包已存在；确认覆盖时加 -Force：$outputPath"
}

$releaseApk = Get-RequiredFile (
  Join-Path $releaseRoot "BabyPlan_${Version}_private-release.apk"
)
$debugApk = Get-RequiredFile (
  Join-Path $releaseRoot "BabyPlan_${Version}_lan-debug.apk"
)
$certificate = Get-RequiredFile (
  Join-Path $releaseRoot 'babyplan-signing-certificate.pem'
)
$checksumFile = Get-RequiredFile (
  Join-Path $releaseRoot 'SHA256SUMS.txt'
)
$manifestFile = Get-RequiredFile (
  Join-Path $releaseRoot 'manifest.json'
)
$signatureEvidence = Get-RequiredFile (
  Join-Path $releaseRoot 'release-signature-verification.txt'
)
$badgingEvidence = Get-RequiredFile (
  Join-Path $releaseRoot 'release-badging.txt'
)
$parentGuide = Get-RequiredFile (
  Join-Path $repositoryRoot 'docs/家长使用与交付说明.md'
)
$deploymentGuide = Get-RequiredFile (
  Join-Path $repositoryRoot 'docs/ops/私有部署与备份恢复.md'
)
$windowsService = Get-RequiredFile (
  Join-Path $releaseRoot "BabyPlan-$Version-windows-service.zip"
)

$expectedChecksums = @{
  $releaseApk.Name = (
    Get-FileHash -LiteralPath $releaseApk.FullName -Algorithm SHA256
  ).Hash.ToLowerInvariant()
  $debugApk.Name = (
    Get-FileHash -LiteralPath $debugApk.FullName -Algorithm SHA256
  ).Hash.ToLowerInvariant()
  $certificate.Name = (
    Get-FileHash -LiteralPath $certificate.FullName -Algorithm SHA256
  ).Hash.ToLowerInvariant()
}
$recordedChecksums = Read-Checksums -Path $checksumFile.FullName
$recordedNames = @($recordedChecksums.Keys | Sort-Object) -join "`n"
$expectedNames = @($expectedChecksums.Keys | Sort-Object) -join "`n"
if ($recordedNames -ne $expectedNames) {
  throw 'SHA256SUMS.txt 包含缺失或未允许的交付文件。'
}
foreach ($name in $expectedChecksums.Keys) {
  if ($recordedChecksums[$name] -ne $expectedChecksums[$name]) {
    throw "SHA256SUMS.txt 与当前文件不一致：$name"
  }
}

$manifest = Get-Content -Raw -LiteralPath $manifestFile.FullName -Encoding UTF8 |
  ConvertFrom-Json
if ($manifest.version -ne $Version) {
  throw 'manifest.json 的版本与交付包版本不一致。'
}
foreach ($variant in $manifest.variants) {
  $path = Join-Path $releaseRoot $variant.file
  $source = Get-RequiredFile $path
  $hash = (
    Get-FileHash -LiteralPath $path -Algorithm SHA256
  ).Hash.ToLowerInvariant()
  if (
    $source.Length -ne [long]$variant.bytes -or
    $hash -ne [string]$variant.sha256
  ) {
    throw "manifest.json 与 APK 不一致：$($variant.file)"
  }
}
$certificateHash = $expectedChecksums[$certificate.Name]
if ($certificateHash -ne [string]$manifest.certificateFileSha256) {
  throw 'manifest.json 与公开证书不一致。'
}

$apksigner = Resolve-ApkSigner
$signatureOutput = @(
  & $apksigner verify --verbose --print-certs $releaseApk.FullName 2>&1
)
if ($LASTEXITCODE -ne 0) {
  throw '正式 APK 签名验证失败。'
}
if (
  ($signatureOutput -join "`n") -notmatch
    [regex]::Escape([string]$manifest.releaseCertificateSha256)
) {
  throw '正式 APK 签名证书与 manifest.json 不一致。'
}

$files = @(
  [pscustomobject]@{ Source = $releaseApk; EntryName = $releaseApk.Name }
  [pscustomobject]@{ Source = $debugApk; EntryName = $debugApk.Name }
  [pscustomobject]@{ Source = $certificate; EntryName = $certificate.Name }
  [pscustomobject]@{ Source = $checksumFile; EntryName = $checksumFile.Name }
  [pscustomobject]@{ Source = $manifestFile; EntryName = $manifestFile.Name }
  [pscustomobject]@{ Source = $signatureEvidence; EntryName = $signatureEvidence.Name }
  [pscustomobject]@{ Source = $badgingEvidence; EntryName = $badgingEvidence.Name }
  [pscustomobject]@{ Source = $windowsService; EntryName = $windowsService.Name }
  [pscustomobject]@{ Source = $parentGuide; EntryName = 'docs/家长使用与交付说明.md' }
  [pscustomobject]@{ Source = $deploymentGuide; EntryName = 'docs/私有部署与备份恢复.md' }
)
foreach ($file in $files) {
  if (
    $file.EntryName -match
      '(^|[\\/])(private|android-signing|\.work|backups?|media)([\\/]|$)' -or
    $file.EntryName -match '\.(p12|jks|keystore|env|db|dump)$'
  ) {
    throw "交付白名单出现禁止项：$($file.EntryName)"
  }
}

$bundleFiles = foreach ($file in $files) {
  [ordered]@{
    entry = "$bundleRoot/$($file.EntryName)"
    source = (
      $file.Source.FullName.Substring($repositoryRoot.Length).TrimStart(
        '\',
        '/'
      ) -replace '\\', '/'
    )
    bytes = $file.Source.Length
    sha256 = (
      Get-FileHash -LiteralPath $file.Source.FullName -Algorithm SHA256
    ).Hash.ToLowerInvariant()
  }
}
$deliveryManifest = [ordered]@{
  product = 'BabyPlan 小芽'
  version = $Version
  generatedAt = (Get-Date).ToUniversalTime().ToString('o')
  sourceChecksumManifest = 'SHA256SUMS.txt'
  files = @($bundleFiles)
  disclaimer = @(
    '交付包含私人签名 Release APK 和局域网 Debug APK。'
    '未包含私钥、keystore、数据库、备份、媒体、环境变量或真实家庭资料。'
    '真机通知、系统选图、双机同步、公网 TLS、生产部署和人工内容审读仍需另行验收。'
  )
}
$readme = @'
BabyPlan 小芽 __VERSION__ 交付包

先阅读：
- docs/家长使用与交付说明.md
- docs/私有部署与备份恢复.md
- release-signature-verification.txt
- manifest.json

本包包含私人签名的 Release APK 和同局域网试用 Debug APK。两者 applicationId 不同，可按文档分别安装。
需要两位家长共享记录时，另外解压 Windows 家庭服务包并阅读它的“先看这里.txt”。
SHA256SUMS.txt 用于核对原始发布文件；DELIVERY-MANIFEST.json 记录本 ZIP 内每个文件的来源与哈希。

本包不包含签名私钥、keystore、数据库、备份、媒体、环境变量、管理员口令或真实家庭资料。
自动化构建与联调不等同于真实 Android 设备、通知送达、照片选择、双机同步、公网 TLS、生产部署和人工内容审读验收。
'@
$readme = $readme.Replace('__VERSION__', $Version)

try {
  if (Test-Path -LiteralPath $partialPath) {
    Remove-Item -LiteralPath $partialPath -Force
  }
  $archive = [System.IO.Compression.ZipFile]::Open(
    $partialPath,
    [System.IO.Compression.ZipArchiveMode]::Create
  )
  try {
    foreach ($file in $files) {
      Add-FileToZip `
        -Archive $archive `
        -Source $file.Source `
        -EntryName $file.EntryName
    }
    $deliveryManifestJson = $deliveryManifest | ConvertTo-Json -Depth 8
    Write-ZipTextEntry `
      -Archive $archive `
      -EntryName "$bundleRoot/DELIVERY-MANIFEST.json" `
      -Text $deliveryManifestJson
    Write-ZipTextEntry `
      -Archive $archive `
      -EntryName "$bundleRoot/README-先看我.txt" `
      -Text $readme
  }
  finally {
    $archive.Dispose()
  }

  $readArchive = [System.IO.Compression.ZipFile]::OpenRead($partialPath)
  try {
    $entryNames = @($readArchive.Entries | ForEach-Object FullName)
    $forbidden = @(
      $entryNames | Where-Object {
        $_ -match
          '(^|/)(private|android-signing|\.work|backups?|media)(/|$)' -or
        $_ -match '\.(p12|jks|keystore|env|db|dump)$'
      }
    )
    if ($forbidden.Count -gt 0) {
      throw "ZIP 回读发现禁止项：$($forbidden -join '、')"
    }
    foreach ($entry in $readArchive.Entries) {
      $stream = $entry.Open()
      try {
        $stream.CopyTo([System.IO.Stream]::Null)
      }
      finally {
        $stream.Dispose()
      }
    }
    if ($entryNames.Count -ne ($files.Count + 2)) {
      throw "ZIP 文件数量异常：$($entryNames.Count)"
    }
  }
  finally {
    $readArchive.Dispose()
  }

  if (Test-Path -LiteralPath $outputPath) {
    Remove-Item -LiteralPath $outputPath -Force
  }
  Move-Item -LiteralPath $partialPath -Destination $outputPath
  $zipHash = (
    Get-FileHash -LiteralPath $outputPath -Algorithm SHA256
  ).Hash.ToLowerInvariant()
  $zip = Get-Item -LiteralPath $outputPath
  [pscustomobject]@{
    output = $zip.FullName
    bytes = $zip.Length
    sha256 = $zipHash
    entries = $files.Count + 2
    releaseApkSha256 = $expectedChecksums[$releaseApk.Name]
    certificateSha256 = $expectedChecksums[$certificate.Name]
  } | ConvertTo-Json
}
finally {
  if (Test-Path -LiteralPath $partialPath) {
    Remove-Item -LiteralPath $partialPath -Force
  }
}
