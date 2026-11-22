[CmdletBinding()]
param(
  [switch]$SkipPrototype,
  [switch]$BuildApk,
  [switch]$BuildReleaseApk,
  [switch]$RunAndroidUnitTests,
  [switch]$RunMigration,
  [switch]$RunHttpE2E,
  [switch]$RunMobileSyncHttp,
  [switch]$RunRestoreDrill,
  [switch]$SkipDatabaseTests,
  [string]$DatabaseUrl,
  [switch]$WriteReport
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$script:results = [System.Collections.Generic.List[object]]::new()
$script:originalTestDatabaseUrl = $env:TEST_DATABASE_URL
$script:originalDatabaseUrl = $env:DATABASE_URL
$script:originalChromium = $env:BABYPLAN_CHROMIUM
$script:originalMobileSync = $env:BABYPLAN_RUN_MOBILE_SYNC_HTTP
$script:failure = $null

function Invoke-Verification {
  param(
    [Parameter(Mandatory)]
    [string]$Name,
    [Parameter(Mandatory)]
    [string]$WorkingDirectory,
    [Parameter(Mandatory)]
    [scriptblock]$Command
  )

  $started = Get-Date
  Write-Host "`n==> $Name" -ForegroundColor Cyan
  Push-Location (Join-Path $root $WorkingDirectory)
  try {
    $global:LASTEXITCODE = 0
    & $Command
    if ($LASTEXITCODE -ne 0) {
      throw "$Name 失败，退出码 $LASTEXITCODE"
    }
    $script:results.Add([pscustomobject]@{
      Name = $Name
      Result = '通过'
      Seconds = [math]::Round(((Get-Date) - $started).TotalSeconds, 1)
    })
  }
  catch {
    $script:results.Add([pscustomobject]@{
      Name = $Name
      Result = '失败'
      Seconds = [math]::Round(((Get-Date) - $started).TotalSeconds, 1)
    })
    throw
  }
  finally {
    Pop-Location
  }
}

function Resolve-AndroidTool {
  param(
    [Parameter(Mandatory)]
    [ValidateSet('apksigner', 'apkanalyzer')]
    [string]$Name
  )

  $command = Get-Command "$Name.bat" -CommandType Application -ErrorAction SilentlyContinue |
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
    if ($Name -eq 'apksigner') {
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
    } else {
      $candidate = Join-Path `
        $sdkRoot `
        'cmdline-tools/latest/bin/apkanalyzer.bat'
      if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
        $candidate = $null
      }
    }
    if ($candidate) {
      return $candidate
    }
  }
  throw "找不到 Android 工具 $Name。可设置 ANDROID_HOME/ANDROID_SDK_ROOT。"
}

function Resolve-Chromium {
  if ($env:BABYPLAN_CHROMIUM) {
    if (-not (Test-Path -LiteralPath $env:BABYPLAN_CHROMIUM -PathType Leaf)) {
      throw 'BABYPLAN_CHROMIUM 指向的文件不存在。'
    }
    return $env:BABYPLAN_CHROMIUM
  }
  $playwrightRoot = Join-Path $env:LOCALAPPDATA 'ms-playwright'
  $candidate = Get-ChildItem `
    -LiteralPath $playwrightRoot `
    -Directory `
    -Filter 'chromium-*' `
    -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending |
    ForEach-Object { Join-Path $_.FullName 'chrome-win/chrome.exe' } |
    Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
    Select-Object -First 1
  if (-not $candidate) {
    throw '找不到 Playwright Chromium。请设置 BABYPLAN_CHROMIUM。'
  }
  return $candidate
}

function Read-ChecksumManifest {
  param(
    [Parameter(Mandatory)]
    [string]$Path,
    [Parameter(Mandatory)]
    [string[]]$ExpectedNames
  )

  $entries = @{}
  foreach ($line in Get-Content -LiteralPath $Path -Encoding UTF8) {
    if (-not $line.Trim()) {
      continue
    }
    if ($line -notmatch '^([0-9A-Fa-f]{64})[ \t]+\*?([^/\\]+)$') {
      throw "校验清单格式无效：$line"
    }
    $name = $Matches[2]
    if ($entries.ContainsKey($name)) {
      throw "校验清单包含重复文件：$name"
    }
    $entries[$name] = $Matches[1].ToLowerInvariant()
  }
  $recordedNames = @($entries.Keys | Sort-Object) -join "`n"
  $expectedSorted = @($ExpectedNames | Sort-Object) -join "`n"
  if ($recordedNames -ne $expectedSorted) {
    throw '校验清单包含缺失或未允许的文件。'
  }
  return ,$entries
}

function Test-ReleaseArtifacts {
  $pubspec = Get-Content -Raw -LiteralPath (Join-Path $root 'apps/mobile/pubspec.yaml')
  if ($pubspec -notmatch '(?m)^version:\s*(?<name>\d+\.\d+\.\d+)\+(?<code>\d+)\s*$') {
    throw 'Flutter 版本必须是版本名加版本码，例如 0.1.1+2。'
  }
  $versionName = $Matches.name
  $versionCode = $Matches.code
  $releaseRoot = Join-Path $root "releases/v$versionName"
  $releaseName = "BabyPlan_${versionName}_private-release.apk"
  $debugName = "BabyPlan_${versionName}_lan-debug.apk"
  $releaseApk = Join-Path $releaseRoot $releaseName
  $debugApk = Join-Path $releaseRoot $debugName
  $certificate = Join-Path $releaseRoot 'babyplan-signing-certificate.pem'
  $manifestPath = Join-Path $releaseRoot 'manifest.json'
  $checksumPath = Join-Path $releaseRoot 'SHA256SUMS.txt'
  foreach ($path in @($releaseApk, $debugApk, $certificate, $manifestPath, $checksumPath)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
      throw "发布产物缺失：$path"
    }
  }

  $expectedNames = @(
    $releaseName
    $debugName
    'babyplan-signing-certificate.pem'
  )
  $checksums = Read-ChecksumManifest `
    -Path $checksumPath `
    -ExpectedNames $expectedNames
  foreach ($name in $expectedNames) {
    $path = Join-Path $releaseRoot $name
    $actual = (
      Get-FileHash -LiteralPath $path -Algorithm SHA256
    ).Hash.ToLowerInvariant()
    if ($actual -ne $checksums[$name]) {
      throw "发布产物 SHA-256 不匹配：$name"
    }
  }

  $manifest = Get-Content -Raw -LiteralPath $manifestPath -Encoding UTF8 |
    ConvertFrom-Json
  if ($manifest.version -ne $versionName -or [string]$manifest.versionCode -ne $versionCode) {
    throw '发布 manifest 与 Flutter 项目的版本不一致。'
  }
  foreach ($variant in $manifest.variants) {
    $path = Join-Path $releaseRoot $variant.file
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
      throw "manifest 引用的 APK 不存在：$($variant.file)"
    }
    $item = Get-Item -LiteralPath $path
    $hash = (
      Get-FileHash -LiteralPath $path -Algorithm SHA256
    ).Hash.ToLowerInvariant()
    if ($item.Length -ne [long]$variant.bytes) {
      throw "manifest 字节数不匹配：$($variant.file)"
    }
    if ($hash -ne [string]$variant.sha256) {
      throw "manifest SHA-256 不匹配：$($variant.file)"
    }
  }
  $certificateHash = (
    Get-FileHash -LiteralPath $certificate -Algorithm SHA256
  ).Hash.ToLowerInvariant()
  if ($certificateHash -ne [string]$manifest.certificateFileSha256) {
    throw 'manifest 中的公开证书 SHA-256 不匹配。'
  }

  $apksigner = Resolve-AndroidTool -Name apksigner
  $apkanalyzer = Resolve-AndroidTool -Name apkanalyzer
  $releaseSignature = @(
    & $apksigner verify --verbose --print-certs $releaseApk 2>&1
  )
  if ($LASTEXITCODE -ne 0) {
    throw '正式 APK 签名验证失败。'
  }
  $releaseSignature | Write-Host
  if (
    ($releaseSignature -join "`n") -notmatch
      'Verified using v2 scheme \(APK Signature Scheme v2\): true'
  ) {
    throw '正式 APK 未通过 APK Signature Scheme v2 验证。'
  }
  $certificateDigest = [string]$manifest.releaseCertificateSha256
  if (
    ($releaseSignature -join "`n") -notmatch
      [regex]::Escape($certificateDigest)
  ) {
    throw '正式 APK 签名证书指纹与 manifest 不一致。'
  }

  $debugSignature = @(& $apksigner verify --verbose $debugApk 2>&1)
  if ($LASTEXITCODE -ne 0) {
    throw '局域网 Debug APK 签名验证失败。'
  }
  if (
    ($debugSignature -join "`n") -notmatch
      'Verified using v2 scheme \(APK Signature Scheme v2\): true'
  ) {
    throw '局域网 Debug APK 未通过 APK Signature Scheme v2 验证。'
  }

  $releaseApplicationId = (
    & $apkanalyzer manifest application-id $releaseApk
  ).Trim()
  $releaseVersionCode = (
    & $apkanalyzer manifest version-code $releaseApk
  ).Trim()
  $releaseVersionName = (
    & $apkanalyzer manifest version-name $releaseApk
  ).Trim()
  $debugApplicationId = (
    & $apkanalyzer manifest application-id $debugApk
  ).Trim()
  $debugVersionCode = (
    & $apkanalyzer manifest version-code $debugApk
  ).Trim()
  $debugVersionName = (
    & $apkanalyzer manifest version-name $debugApk
  ).Trim()
  if ($LASTEXITCODE -ne 0) {
    throw 'APK 包信息读取失败。'
  }
  $releaseVariant = $manifest.variants |
    Where-Object { $_.name -eq 'private-release' }
  $debugVariant = $manifest.variants |
    Where-Object { $_.name -eq 'lan-debug' }
  if (
    $releaseApplicationId -ne $releaseVariant.applicationId -or
    $debugApplicationId -ne $debugVariant.applicationId
  ) {
    throw 'APK applicationId 与 manifest 不一致。'
  }
  if (
    $releaseVersionCode -ne [string]$manifest.versionCode -or
    $releaseVersionName -ne [string]$manifest.version -or
    $debugVersionCode -ne $versionCode -or
    $debugVersionName -ne "$versionName-dev"
  ) {
    throw 'APK 版本号与 manifest 不一致。'
  }

  $releaseXml = & $apkanalyzer manifest print $releaseApk
  $debugXml = & $apkanalyzer manifest print $debugApk
  if ($LASTEXITCODE -ne 0) {
    throw 'APK Manifest 读取失败。'
  }
  if (
    ($releaseXml -join "`n") -notmatch
      'android:usesCleartextTraffic="true"'
  ) {
    throw '正式 APK 没有允许 HTTP 家庭服务。'
  }
  if (
    ($debugXml -join "`n") -notmatch
      'android:usesCleartextTraffic="true"'
  ) {
    throw '局域网 Debug APK 没有启用明文流量。'
  }
  if (($releaseXml -join "`n") -match 'android:debuggable="true"') {
    throw '正式 APK 被标记为可调试。'
  }
  Write-Host (
    '发布 APK：{0} {1}；Debug APK：{2}；签名、哈希、包名和网络策略一致。' -f
      $releaseApplicationId,
      $releaseVersionName,
      $debugApplicationId
  )
}

function Assert-GeneratedDocumentsCurrent {
  $developmentPlan = Join-Path $root 'deliverables/v2/开发计划.html'
  $taskDetails = Join-Path $root 'docs/development/开发任务明细.md'
  $reviewLedger = Join-Path $root 'docs/content/逐卡审读台账.md'
  $paths = @($developmentPlan, $taskDetails, $reviewLedger)
  $before = @{}
  foreach ($path in $paths) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
      throw "生成文档缺失：$path"
    }
    $before[$path] = (
      Get-FileHash -LiteralPath $path -Algorithm SHA256
    ).Hash
  }

  & python -X utf8 tools/render_content_review_ledger.py
  if ($LASTEXITCODE -ne 0) {
    throw '内容审读台账生成失败。'
  }
  & python -X utf8 tools/render_development_plan.py
  if ($LASTEXITCODE -ne 0) {
    throw '开发计划生成失败。'
  }

  $changed = @()
  foreach ($path in $paths) {
    $after = (
      Get-FileHash -LiteralPath $path -Algorithm SHA256
    ).Hash
    if ($after -ne $before[$path]) {
      $changed += [System.IO.Path]::GetFileName($path)
    }
  }
  if ($changed.Count -gt 0) {
    throw (
      "生成文档与源数据不一致，已重新生成：$($changed -join '、')。" +
      '请复核后重跑。'
    )
  }
}

try {
  Write-Host 'BabyPlan 验证开始' -ForegroundColor Green
  Write-Host "仓库：$root"

  Invoke-Verification '内容校验器自测' '.' {
    & python -X utf8 tools/test_validate_v2_content.py
  }
  Invoke-Verification 'v2 内容结构' '.' {
    & python -I tools/validate_v2_content.py `
      content/candidate/babyplan-18-23-v2.json
  }
  Invoke-Verification 'v2 OpenAPI 与设计合同' '.' {
    & python -I tools/validate_v2_design.py
  }
  Invoke-Verification '交付物静态检查' '.' {
    & node tools/check_v2_delivery.cjs
  }
  if (-not $SkipPrototype) {
    Invoke-Verification '原型浏览器回归' '.' {
      & node tools/check_v2_prototype.cjs
    }
  }
  Invoke-Verification '生成文档与源数据一致' '.' {
    Assert-GeneratedDocumentsCurrent
  }

  if (-not $SkipDatabaseTests) {
    if (-not $DatabaseUrl) {
      $DatabaseUrl = if ($env:TEST_DATABASE_URL) {
        $env:TEST_DATABASE_URL
      } elseif ($env:DATABASE_URL) {
        $env:DATABASE_URL
      } else {
        'postgresql://babyplan:x@127.0.0.1:54329/babyplan_dev'
      }
    }
    $env:TEST_DATABASE_URL = $DatabaseUrl
    $env:DATABASE_URL = $DatabaseUrl

    if ($RunMigration) {
      Invoke-Verification 'PostgreSQL 迁移（真实数据库）' 'services/api' {
        & npm.cmd run db:migrate
      }
    }
    Invoke-Verification '服务端数据库集成测试' 'services/api' {
      $testFiles = @(
        Get-ChildItem -LiteralPath 'test' -File -Filter '*.test.ts' |
          Where-Object { $_.Name -notin @('http_e2e.test.ts', 'deletion_restore.test.ts', 'mobile_sync_http.test.ts') } |
          Sort-Object Name |
          ForEach-Object { Join-Path 'test' $_.Name }
      )
      if ($testFiles.Count -eq 0) {
        throw '没有找到默认服务端测试。'
      }
      & node --import tsx --test --test-concurrency=1 @testFiles
    }
    if ($RunHttpE2E) {
      $env:BABYPLAN_CHROMIUM = Resolve-Chromium
      Invoke-Verification 'HTTP/Chromium 跨端联调' 'services/api' {
        & node --import tsx --test --test-concurrency=1 `
          test/http_e2e.test.ts
      }
    }
    if ($RunMobileSyncHttp) {
      Invoke-Verification '真实 HTTP 两份手机 SQLite 同步' 'services/api' {
        $env:BABYPLAN_RUN_MOBILE_SYNC_HTTP = '1'
        try { & node --import tsx --test test/mobile_sync_http.test.ts }
        finally { $env:BABYPLAN_RUN_MOBILE_SYNC_HTTP = $script:originalMobileSync }
      }
    }
  }

  Invoke-Verification '服务端类型检查' 'services/api' {
    & npm.cmd run typecheck
  }
  Invoke-Verification '服务端生产构建' 'services/api' {
    & npm.cmd run build
  }
  if ($RunRestoreDrill) {
    Invoke-Verification '隔离 PostgreSQL 删除重放恢复演练' 'services/api' {
      if (-not $env:BABYPLAN_DELETION_DRILL_ADMIN_URL) {
        throw '删除重放演练需要专用隔离集群的 BABYPLAN_DELETION_DRILL_ADMIN_URL。'
      }
      & node --import tsx --test test/deletion_restore.test.ts
    }
  }
  Invoke-Verification '服务端依赖审计' 'services/api' {
    & npm.cmd audit --audit-level=low
  }
  Invoke-Verification '家长网页测试' 'apps/web' {
    & npm.cmd test
  }
  Invoke-Verification '家长网页 JavaScript 语法' 'apps/web' {
    $files = @(
      'server.mjs'
      'public/app.js'
      'public/lib/api.js'
      'public/lib/dates.js'
      'public/lib/growth.js'
      'public/lib/validation.js'
    )
    foreach ($file in $files) {
      & node --check $file
      if ($LASTEXITCODE -ne 0) {
        throw "JavaScript 语法检查失败：$file"
      }
    }
  }
  Invoke-Verification 'Flutter 格式检查' 'apps/mobile' {
    & dart format --output=none --set-exit-if-changed lib test
  }
  Invoke-Verification 'Flutter 静态检查' 'apps/mobile' {
    & flutter.bat analyze
  }
  Invoke-Verification 'Flutter 测试' 'apps/mobile' {
    & flutter.bat test
  }
  if ($RunAndroidUnitTests) {
    Invoke-Verification 'Android 原生闹钟规则测试' 'apps/mobile/android' {
      & .\gradlew.bat :app:testDebugUnitTest
    }
  }
  if ($BuildApk) {
    Invoke-Verification 'Android Debug APK 构建' 'apps/mobile' {
      & flutter.bat build apk --debug
    }
  }
  if ($BuildReleaseApk) {
    Invoke-Verification 'Android Release APK 构建' 'apps/mobile' {
      & flutter.bat build apk --release
    }
  }
  Invoke-Verification '发布 APK 签名、哈希与包信息' '.' {
    Test-ReleaseArtifacts
  }
}
catch {
  $script:failure = $_
}
finally {
  $env:TEST_DATABASE_URL = $script:originalTestDatabaseUrl
  $env:DATABASE_URL = $script:originalDatabaseUrl
  $env:BABYPLAN_CHROMIUM = $script:originalChromium

  Write-Host "`n验证汇总" -ForegroundColor Cyan
  $script:results | Format-Table -AutoSize
  $failed = @(
    $script:results | Where-Object { $_.Result -eq '失败' }
  )
  $report = [ordered]@{
    generatedAt = (Get-Date).ToUniversalTime().ToString('o')
    repository = $root
    success = ($null -eq $script:failure) -and ($failed.Count -eq 0)
    options = [ordered]@{
      skipPrototype = [bool]$SkipPrototype
      runMigration = [bool]$RunMigration
      runHttpE2E = [bool]$RunHttpE2E
      runMobileSyncHttp = [bool]$RunMobileSyncHttp
      runRestoreDrill = [bool]$RunRestoreDrill
      skipDatabaseTests = [bool]$SkipDatabaseTests
      buildApk = [bool]$BuildApk
      buildReleaseApk = [bool]$BuildReleaseApk
      runAndroidUnitTests = [bool]$RunAndroidUnitTests
    }
    results = @($script:results)
    error = if ($script:failure) {
      $script:failure.Exception.Message
    } else {
      $null
    }
  }
  if ($WriteReport) {
    $reportPath = Join-Path $root '.work/verification/latest.json'
    New-Item `
      -ItemType Directory `
      -Path (Split-Path $reportPath) `
      -Force | Out-Null
    $report | ConvertTo-Json -Depth 8 |
      Set-Content -LiteralPath $reportPath -Encoding UTF8
    Write-Host "报告：$reportPath"
  }
  if ($script:failure -or $failed.Count -gt 0) {
    if ($script:failure) {
      Write-Host $script:failure -ForegroundColor Red
    } else {
      Write-Host '验证存在失败项。' -ForegroundColor Red
    }
    exit 1
  }
}
