[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [string]$EnvironmentFile,
  [string]$BackupRoot,
  [switch]$AllowOnlineBackup
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'BabyPlanOps.Common.psm1') -Force

$values = Read-BabyPlanEnvFile -Path $EnvironmentFile
if (-not $values.ContainsKey('DATABASE_URL')) {
  throw '环境文件缺少 DATABASE_URL。'
}
if (-not $values.ContainsKey('MEDIA_ROOT')) {
  throw '环境文件缺少 MEDIA_ROOT；无法确认 API 实际使用的媒体目录。'
}
$mediaSource = Get-NormalizedFullPath -Path $values.MEDIA_ROOT
if ($values.ContainsKey('MEDIA_STORAGE_PATH')) {
  $mediaOperationPath = Get-NormalizedFullPath -Path $values.MEDIA_STORAGE_PATH
  if (
    -not $mediaOperationPath.Equals(
      $mediaSource,
      [StringComparison]::OrdinalIgnoreCase
    )
  ) {
    throw 'MEDIA_ROOT 与 MEDIA_STORAGE_PATH 指向不同目录，拒绝备份。'
  }
}
if (-not (Test-Path -LiteralPath $mediaSource -PathType Container)) {
  throw "媒体目录不存在：$mediaSource"
}
$recoveryOutboxPath = $null
if (
  $values.ContainsKey('RECOVERY_OUTBOX_ROOT') -and
  $values.RECOVERY_OUTBOX_ROOT
) {
  $recoveryOutboxPath = Get-NormalizedFullPath -Path $values.RECOVERY_OUTBOX_ROOT
} elseif ($values.ContainsKey('NODE_ENV') -and $values.NODE_ENV -eq 'production') {
  throw '生产环境缺少 RECOVERY_OUTBOX_ROOT；无法确认账号恢复投递目录安全。'
}
$rootValue = if ($BackupRoot) {
  $BackupRoot
} elseif ($values.ContainsKey('BACKUP_ROOT')) {
  $values.BACKUP_ROOT
} else {
  throw '没有提供 -BackupRoot，环境文件也没有 BACKUP_ROOT。'
}
$root = Get-NormalizedFullPath -Path $rootValue
if (Test-PathTreesOverlap -Path $root -OtherPath $mediaSource) {
  throw '备份目录不能位于媒体目录中。'
}
if ($recoveryOutboxPath) {
  if (-not (Test-Path -LiteralPath $recoveryOutboxPath -PathType Container)) {
    throw "RECOVERY_OUTBOX_ROOT 目录不存在：$recoveryOutboxPath"
  }
  if (Test-PathTreesOverlap -Path $recoveryOutboxPath -OtherPath $mediaSource) {
    throw 'RECOVERY_OUTBOX_ROOT 必须与媒体目录完全分离。'
  }
  if (Test-PathTreesOverlap -Path $recoveryOutboxPath -OtherPath $root) {
    throw 'RECOVERY_OUTBOX_ROOT 必须与备份目录完全分离。'
  }
}
New-Item -ItemType Directory -Path $root -Force | Out-Null
$root = (Resolve-Path -LiteralPath $root).Path
Protect-BabyPlanSecretDirectory -Path $root

$apiHost = if ($values.ContainsKey('API_HOST')) { $values.API_HOST } else { '127.0.0.1' }
$apiPort = if ($values.ContainsKey('API_PORT')) { [int]$values.API_PORT } else { 4318 }
$apiOnline = Test-BabyPlanApiOnline -HostName $apiHost -Port $apiPort
if ($apiOnline -and -not $AllowOnlineBackup) {
  throw 'API 正在监听。为保证数据库与媒体快照一致，请先停止 API；仅接受有风险时使用 -AllowOnlineBackup。'
}
$journalCheck = Invoke-BabyPlanDeletionJournal -Values $values -Action 'prepare-backup'

$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
$finalDirectory = Join-Path $root "$stamp-$([Guid]::NewGuid().ToString('N').Substring(0,8))"
$partialDirectory = Join-Path $root ".$([System.IO.Path]::GetFileName($finalDirectory)).partial"
Assert-PathInside -Path $partialDirectory -Parent $root | Out-Null
Assert-PathInside -Path $finalDirectory -Parent $root | Out-Null
New-Item -ItemType Directory -Path $partialDirectory | Out-Null
Protect-BabyPlanSecretDirectory -Path $partialDirectory

$postgresBackup = @{}
try {
  $postgresBackup = Set-PostgresConnectionEnvironment -DatabaseUrl $values.DATABASE_URL
  $pgDump = Resolve-PostgresTool -Name 'pg_dump'
  $pgRestore = Resolve-PostgresTool -Name 'pg_restore'
  $psql = Resolve-PostgresTool -Name 'psql'
  $databaseDump = Join-Path $partialDirectory 'database.dump'
  Invoke-CheckedProcess -FilePath $pgDump `
    -ArgumentList @(
      '--format=custom',
      '--no-owner',
      '--no-acl',
      '--file',
      $databaseDump,
      $env:PGDATABASE
    ) `
    -FailureMessage 'pg_dump 失败'
  Invoke-CheckedProcess -FilePath $pgRestore `
    -ArgumentList @('--list', $databaseDump) `
    -FailureMessage '数据库备份归档校验失败' `
    -SuppressOutput

  $mediaCopy = Join-Path $partialDirectory 'media'
  New-Item -ItemType Directory -Path $mediaCopy | Out-Null
  $sourceDigestBefore = Get-TreeDigest -Path $mediaSource
  foreach ($file in Get-ChildItem -LiteralPath $mediaSource -File -Recurse -Force) {
    if (($file.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "媒体目录包含符号链接，拒绝备份：$($file.FullName)"
    }
    $relative = [System.IO.Path]::GetRelativePath($mediaSource, $file.FullName)
    $destination = Join-Path $mediaCopy $relative
    New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force |
      Out-Null
    Copy-Item -LiteralPath $file.FullName -Destination $destination
  }
  $sourceDigest = Get-TreeDigest -Path $mediaSource
  $copyDigest = Get-TreeDigest -Path $mediaCopy
  if (
    $sourceDigestBefore.fileCount -ne $sourceDigest.fileCount -or
    $sourceDigestBefore.byteCount -ne $sourceDigest.byteCount -or
    $sourceDigestBefore.digestSha256 -ne $sourceDigest.digestSha256 -or
    $sourceDigest.fileCount -ne $copyDigest.fileCount -or
    $sourceDigest.byteCount -ne $copyDigest.byteCount -or
    $sourceDigest.digestSha256 -ne $copyDigest.digestSha256
  ) {
    throw '媒体复制后的文件数量、大小或摘要不一致。'
  }
  if (
    -not $apiOnline -and
    (Test-BabyPlanApiOnline -HostName $apiHost -Port $apiPort)
  ) {
    throw '备份期间 API 被重新启动，快照一致性无法确认；请停止服务后重试。'
  }

  $migrationOutput = & $psql --no-psqlrc --tuples-only --no-align `
    --command "SELECT name FROM app.schema_migrations ORDER BY name"
  if ($LASTEXITCODE -ne 0) {
    throw "读取迁移记录失败（退出码 $LASTEXITCODE）"
  }
  $migrations = @(
    $migrationOutput |
      ForEach-Object { ([string]$_).Trim() } |
      Where-Object { $_ }
  )
  $serverVersionOutput = & $psql --no-psqlrc --tuples-only --no-align `
    --command 'SHOW server_version'
  if ($LASTEXITCODE -ne 0) {
    throw "读取 PostgreSQL 版本失败（退出码 $LASTEXITCODE）"
  }
  $postgresVersion = (@($serverVersionOutput) -join '').Trim()
  $objectOutput = & $psql --no-psqlrc --tuples-only --no-align `
    --command @'
SELECT object_key
FROM app.media
WHERE state = 'ready' AND object_key IS NOT NULL
UNION
SELECT object_key
FROM app.exports
WHERE status = 'ready' AND object_key IS NOT NULL
ORDER BY 1
'@
  if ($LASTEXITCODE -ne 0) {
    throw "读取媒体对象引用失败（退出码 $LASTEXITCODE）"
  }
  $referencedObjectKeys = @(
    $objectOutput |
      ForEach-Object { ([string]$_).Trim() } |
      Where-Object { $_ }
  )
  foreach ($objectKey in $referencedObjectKeys) {
    if ([System.IO.Path]::IsPathRooted($objectKey)) {
      throw "数据库包含绝对媒体对象路径，拒绝备份：$objectKey"
    }
    $objectPath = Get-NormalizedFullPath `
      -Path $objectKey.Replace('/', '\') `
      -BasePath $mediaSource
    Assert-PathInside -Path $objectPath -Parent $mediaSource | Out-Null
    if (-not (Test-Path -LiteralPath $objectPath -PathType Leaf)) {
      throw "数据库引用的媒体对象不存在：$objectKey"
    }
  }
  $databaseDigest = (Get-FileHash -LiteralPath $databaseDump -Algorithm SHA256).Hash
  $manifest = [ordered]@{
    format = 'babyplan-private-backup-v2'
    deletionJournalId = $journalCheck.journalId
    createdAt = (Get-Date).ToUniversalTime().ToString('o')
    consistency = if ($apiOnline) {
      'online_unverified'
    } else {
      'api_stopped_verified'
    }
    database = [ordered]@{
      format = 'postgresql-custom'
      dump = 'database.dump'
      sha256 = $databaseDigest
      postgresVersion = $postgresVersion
      migrations = $migrations
    }
    media = [ordered]@{
      directory = 'media'
      fileCount = $copyDigest.fileCount
      byteCount = $copyDigest.byteCount
      digestSha256 = $copyDigest.digestSha256
      referencedObjectCount = $referencedObjectKeys.Count
    }
    warnings = @(
      if ($apiOnline) {
        'API 未停止，数据库与媒体可能来自不同时间点。'
      }
    )
  }
  $manifest |
    ConvertTo-Json -Depth 8 |
    Set-Content -LiteralPath (Join-Path $partialDirectory 'manifest.json') `
      -Encoding UTF8
  Move-Item -LiteralPath $partialDirectory -Destination $finalDirectory
  Write-Host "备份完成：$finalDirectory" -ForegroundColor Green
  return [pscustomobject]@{
    path = $finalDirectory
    databaseSha256 = $databaseDigest
    mediaFiles = $copyDigest.fileCount
    mediaDigestSha256 = $copyDigest.digestSha256
    consistency = $manifest.consistency
  }
} catch {
  if (Test-Path -LiteralPath $partialDirectory) {
    $safePartial = Assert-PathInside -Path $partialDirectory -Parent $root
    Remove-Item -LiteralPath $safePartial -Recurse -Force
  }
  throw
} finally {
  if ($postgresBackup.Count) {
    Restore-BabyPlanEnvironment -Original $postgresBackup
  }
}
