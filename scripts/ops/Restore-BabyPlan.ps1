[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [string]$EnvironmentFile,
  [Parameter(Mandatory)]
  [string]$BackupPath,
  [string]$TargetDatabase,
  [string]$MediaRestorePath,
  [string]$DeletionJournalRoot,
  [string]$AdminDatabaseUrlEnvironmentVariable = 'BABYPLAN_RESTORE_ADMIN_DATABASE_URL',
  [switch]$ConfirmRestore,
  [switch]$KeepFailedDatabase
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'BabyPlanOps.Common.psm1') -Force

if (-not $ConfirmRestore) {
  throw '恢复会创建新数据库和媒体目录。核对参数后使用 -ConfirmRestore。'
}
if ($AdminDatabaseUrlEnvironmentVariable -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') {
  throw '管理员连接环境变量名格式无效。'
}
$adminDatabaseUrl = [Environment]::GetEnvironmentVariable(
  $AdminDatabaseUrlEnvironmentVariable,
  'Process'
)
if (-not $adminDatabaseUrl) {
  throw "请通过当前进程环境变量 $AdminDatabaseUrlEnvironmentVariable 提供恢复管理员连接，避免写入命令历史。"
}
$values = Read-BabyPlanEnvFile -Path $EnvironmentFile
if (-not $values.ContainsKey('DATABASE_URL')) {
  throw '环境文件缺少 DATABASE_URL。'
}
if ($DeletionJournalRoot) {
  $values.DELETION_JOURNAL_ROOT = Get-NormalizedFullPath -Path $DeletionJournalRoot
}
$apiHost = if ($values.ContainsKey('API_HOST')) { $values.API_HOST } else { '127.0.0.1' }
$apiPort = if ($values.ContainsKey('API_PORT')) { [int]$values.API_PORT } else { 4318 }
if (Test-BabyPlanApiOnline -HostName $apiHost -Port $apiPort) {
  throw '恢复前请停止源 API 和家长网页，避免在重放期间产生新的删除。'
}
$sourceUri = [Uri]$values.DATABASE_URL
$adminUri = [Uri]$adminDatabaseUrl
if (
  -not $sourceUri.Host.Equals(
    $adminUri.Host,
    [StringComparison]::OrdinalIgnoreCase
  ) -or
  $sourceUri.Port -ne $adminUri.Port
) {
  throw '恢复管理员连接必须与应用 DATABASE_URL 指向同一 PostgreSQL 主机和端口。'
}
$roleParts = $sourceUri.UserInfo.Split(':', 2)
if ($roleParts.Count -ne 2 -or -not $roleParts[0]) {
  throw '应用 DATABASE_URL 缺少用户名。'
}
$targetRoleName = [Uri]::UnescapeDataString($roleParts[0])
if ($targetRoleName -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') {
  throw '应用数据库角色名格式无效。'
}
$sourceBackup = Get-NormalizedFullPath -Path $BackupPath
if (-not (Test-Path -LiteralPath $sourceBackup -PathType Container)) {
  throw "备份目录不存在：$sourceBackup"
}
$manifestPath = Join-Path $sourceBackup 'manifest.json'
$dumpPath = Join-Path $sourceBackup 'database.dump'
$mediaBackupPath = Join-Path $sourceBackup 'media'
foreach ($path in @($manifestPath, $dumpPath)) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    throw "备份缺少文件：$path"
  }
}
if (-not (Test-Path -LiteralPath $mediaBackupPath -PathType Container)) {
  throw "备份缺少媒体目录：$mediaBackupPath"
}
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 |
  ConvertFrom-Json
if ($manifest.format -ne 'babyplan-private-backup-v2') {
  throw '此备份缺少可验证的部署台账绑定，不能作为可上线的恢复环境。'
}
if ($manifest.consistency -ne 'api_stopped_verified') {
  throw '此备份没有确认数据库和照片处于同一快照，不能直接恢复上线。'
}
$backupTimestamp = if ($manifest.createdAt -is [DateTime]) {
  ([DateTimeOffset]$manifest.createdAt).ToUniversalTime()
} else {
  [DateTimeOffset]::Parse([string]$manifest.createdAt).ToUniversalTime()
}
$journalId = [Guid]::Empty
if (-not [Guid]::TryParse([string]$manifest.deletionJournalId, [ref]$journalId)) {
  throw '备份缺少有效的删除台账标识。'
}
if (-not $values.ContainsKey('DELETION_JOURNAL_ROOT')) {
  $values.DELETION_JOURNAL_ROOT = Join-Path (Split-Path -Parent $values.RECOVERY_OUTBOX_ROOT) 'deletion-journal'
}
if (-not (Test-Path -LiteralPath (Join-Path $values.DELETION_JOURNAL_ROOT 'journal.json') -PathType Leaf)) {
  throw '缺少最新删除台账，无法确认已删除的家庭资料不会复活。'
}
$actualDumpHash = (Get-FileHash -LiteralPath $dumpPath -Algorithm SHA256).Hash
if ($actualDumpHash -ne $manifest.database.sha256) {
  throw '数据库备份摘要与清单不一致。'
}
$actualMedia = Get-TreeDigest -Path $mediaBackupPath
if (
  $actualMedia.fileCount -ne $manifest.media.fileCount -or
  $actualMedia.byteCount -ne $manifest.media.byteCount -or
  $actualMedia.digestSha256 -ne $manifest.media.digestSha256
) {
  throw '媒体备份摘要与清单不一致。'
}

$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMdd_HHmmss')
if (-not $TargetDatabase) {
  $TargetDatabase = "babyplan_restore_$stamp"
}
if ($TargetDatabase -notmatch '^[a-z_][a-z0-9_]{0,62}$') {
  throw 'TargetDatabase 只能包含小写字母、数字和下划线。'
}
$restoreBase = if ($values.ContainsKey('RESTORE_ROOT')) {
  Get-NormalizedFullPath -Path $values.RESTORE_ROOT
} elseif ($values.ContainsKey('BACKUP_ROOT')) {
  Get-NormalizedFullPath -Path (Join-Path $values.BACKUP_ROOT 'restores')
} else {
  Join-Path (Split-Path -Parent (Get-NormalizedFullPath -Path $EnvironmentFile)) `
    'restores'
}
New-Item -ItemType Directory -Path $restoreBase -Force | Out-Null
$restoreBase = (Resolve-Path -LiteralPath $restoreBase).Path
if (Test-PathTreesOverlap -Path $restoreBase -OtherPath $values.DELETION_JOURNAL_ROOT) {
  throw '恢复目标与独立删除台账必须位于不同目录。'
}
if (-not $MediaRestorePath) {
  $MediaRestorePath = Join-Path $restoreBase "media-$TargetDatabase"
}
$mediaTarget = Get-NormalizedFullPath -Path $MediaRestorePath
Assert-PathInside -Path $mediaTarget -Parent $restoreBase | Out-Null
if (Test-Path -LiteralPath $mediaTarget) {
  throw "媒体恢复目录已存在，拒绝合并：$mediaTarget"
}
$recoveryOutboxTarget = Get-NormalizedFullPath -Path (
  Join-Path $restoreBase "recovery-$TargetDatabase"
)
Assert-PathInside -Path $recoveryOutboxTarget -Parent $restoreBase | Out-Null
if (Test-Path -LiteralPath $recoveryOutboxTarget) {
  throw "恢复账号投递目录已存在，拒绝合并：$recoveryOutboxTarget"
}

$adminBackup = @{}
$databaseCreated = $false
$mediaCreated = $false
$recoveryCreated = $false
$restoreEnvironmentPath = Join-Path $restoreBase "restored-$TargetDatabase.env"
if (Test-Path -LiteralPath $restoreEnvironmentPath) {
  throw "恢复环境文件已存在：$restoreEnvironmentPath"
}
$environmentCreated = $false
$stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
$createdb = $null
$dropdb = $null
try {
  $adminBackup = Set-PostgresConnectionEnvironment -DatabaseUrl $adminDatabaseUrl
  $psql = Resolve-PostgresTool -Name 'psql'
  $createdb = Resolve-PostgresTool -Name 'createdb'
  $dropdb = Resolve-PostgresTool -Name 'dropdb'
  $pgRestore = Resolve-PostgresTool -Name 'pg_restore'
  $serverVersionOutput = & $psql --no-psqlrc --tuples-only --no-align `
    --command 'SHOW server_version'
  if ($LASTEXITCODE -ne 0) {
    throw "读取恢复服务器 PostgreSQL 版本失败（退出码 $LASTEXITCODE）"
  }
  $restoreServerVersion = (@($serverVersionOutput) -join '').Trim()
  $sourcePostgresVersion = $null
  if ($manifest.database.PSObject.Properties.Name -contains 'postgresVersion') {
    $sourcePostgresVersion = [string]$manifest.database.postgresVersion
  }
  if (
    $sourcePostgresVersion -and
    $sourcePostgresVersion -ne $restoreServerVersion
  ) {
    Write-Warning "备份 PostgreSQL 版本为 $sourcePostgresVersion，恢复服务器为 $restoreServerVersion；恢复后必须重新执行完整验收。"
  }
  $existing = & $psql --no-psqlrc --tuples-only --no-align `
    --dbname postgres `
    --command "SELECT 1 FROM pg_database WHERE datname='$TargetDatabase'"
  if ($LASTEXITCODE -ne 0) {
    throw "检查目标数据库失败（退出码 $LASTEXITCODE）"
  }
  $existingText = (@($existing) -join '').Trim()
  if ($existingText) {
    throw "目标数据库已存在，拒绝覆盖：$TargetDatabase"
  }
  Invoke-CheckedProcess -FilePath $createdb `
    -ArgumentList @(
      '--template',
      'template0',
      '--owner',
      $targetRoleName,
      $TargetDatabase
    ) `
    -FailureMessage '创建恢复数据库失败'
  $databaseCreated = $true
  Invoke-CheckedProcess -FilePath $pgRestore `
    -ArgumentList @(
      '--exit-on-error',
      '--no-owner',
      '--no-acl',
      '--dbname',
      $TargetDatabase,
      $dumpPath
    ) `
    -FailureMessage '数据库恢复失败'
  $targetRoleLiteral = $targetRoleName.Replace("'", "''")
  $ownershipSql = @"
ALTER SCHEMA app OWNER TO "$targetRoleName";
DO `$ownership`$
DECLARE
  object_record record;
  object_role text := '$targetRoleLiteral';
BEGIN
  FOR object_record IN
    SELECT relname, relkind
    FROM pg_class
    JOIN pg_namespace ON pg_namespace.oid = pg_class.relnamespace
    WHERE nspname = 'app' AND relkind IN ('r', 'S', 'v', 'm')
  LOOP
    IF object_record.relkind = 'S' THEN
      EXECUTE format(
        'ALTER SEQUENCE app.%I OWNER TO %I',
        object_record.relname,
        object_role
      );
    ELSIF object_record.relkind = 'v' THEN
      EXECUTE format(
        'ALTER VIEW app.%I OWNER TO %I',
        object_record.relname,
        object_role
      );
    ELSE
      EXECUTE format(
        'ALTER TABLE app.%I OWNER TO %I',
        object_record.relname,
        object_role
      );
    END IF;
  END LOOP;

  FOR object_record IN
    SELECT p.oid::regprocedure AS signature
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'app'
  LOOP
    EXECUTE format(
      'ALTER FUNCTION %s OWNER TO %I',
      object_record.signature,
      object_role
    );
  END LOOP;

  FOR object_record IN
    SELECT typname
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'app' AND typtype IN ('d', 'e')
  LOOP
    EXECUTE format(
      'ALTER TYPE app.%I OWNER TO %I',
      object_record.typname,
      object_role
    );
  END LOOP;
END
`$ownership`$;
"@
  $ownershipSql | & $psql --no-psqlrc --set ON_ERROR_STOP=1 `
    --dbname $TargetDatabase | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "把恢复对象所有权交给应用角色失败（退出码 $LASTEXITCODE）"
  }

  $targetBuilder = [UriBuilder]($values.DATABASE_URL)
  $targetBuilder.Path = "/$TargetDatabase"
  $targetDatabaseUrl = $targetBuilder.Uri.AbsoluteUri
  $targetAppBackup = @{}
  try {
    $targetAppBackup = Set-PostgresConnectionEnvironment `
      -DatabaseUrl $targetDatabaseUrl
    $migrationOutput = & $psql --no-psqlrc --tuples-only --no-align `
      --command 'SELECT name FROM app.schema_migrations ORDER BY name'
  } finally {
    if ($targetAppBackup.Count) {
      Restore-BabyPlanEnvironment -Original $targetAppBackup
    }
  }
  if ($LASTEXITCODE -ne 0) {
    throw "使用应用角色读取恢复库失败（退出码 $LASTEXITCODE）"
  }
  $restoredMigrations = @(
    $migrationOutput |
      ForEach-Object { ([string]$_).Trim() } |
      Where-Object { $_ }
  )
  $expectedMigrations = @($manifest.database.migrations | ForEach-Object { [string]$_ })
  if (($expectedMigrations -join "`n") -ne ($restoredMigrations -join "`n")) {
    throw '恢复后的迁移记录与备份清单不一致。'
  }

  New-Item -ItemType Directory -Path $mediaTarget | Out-Null
  $mediaCreated = $true
  foreach ($file in Get-ChildItem -LiteralPath $mediaBackupPath -File -Recurse -Force) {
    $relative = [System.IO.Path]::GetRelativePath(
      $mediaBackupPath,
      $file.FullName
    )
    $destination = Join-Path $mediaTarget $relative
    New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force |
      Out-Null
    Copy-Item -LiteralPath $file.FullName -Destination $destination
  }
  Protect-BabyPlanSecretDirectory -Path $mediaTarget
  $restoredMedia = Get-TreeDigest -Path $mediaTarget
  if (
    $restoredMedia.fileCount -ne $manifest.media.fileCount -or
    $restoredMedia.byteCount -ne $manifest.media.byteCount -or
    $restoredMedia.digestSha256 -ne $manifest.media.digestSha256
  ) {
    throw '恢复后的媒体摘要与备份清单不一致。'
  }
  New-Item -ItemType Directory -Path $recoveryOutboxTarget | Out-Null
  $recoveryCreated = $true
  Protect-BabyPlanSecretDirectory -Path $recoveryOutboxTarget

  $newEnvironment = @{}
  foreach ($entry in $values.GetEnumerator()) {
    $newEnvironment[$entry.Key] = $entry.Value
  }
  $newEnvironment.DATABASE_URL = $targetDatabaseUrl
  $newEnvironment.MEDIA_ROOT = $mediaTarget.Replace('\', '/')
  $newEnvironment.MEDIA_STORAGE_PATH = $mediaTarget.Replace('\', '/')
  $newEnvironment.RECOVERY_OUTBOX_ROOT = $recoveryOutboxTarget.Replace('\', '/')
  $newEnvironment.DELETION_JOURNAL_ROOT = (Get-NormalizedFullPath -Path $values.DELETION_JOURNAL_ROOT).Replace('\', '/')
  # 先校验未清理前的媒体摘要，再从独立台账执行删除。失败不生成环境文件。
  $replay = Invoke-BabyPlanDeletionJournal -Values $newEnvironment -Action 'replay-restore' -JournalId $journalId.ToString()
  $postReplayDigest = Get-TreeDigest -Path $mediaTarget
  $targetAppBackup = Set-PostgresConnectionEnvironment -DatabaseUrl $targetDatabaseUrl
  try {
    $restoredMigrations = @(& $psql --no-psqlrc --tuples-only --no-align `
      --command 'SELECT name FROM app.schema_migrations ORDER BY name')
    if ($LASTEXITCODE -ne 0) { throw '重放后无法核对数据库版本。' }
  } finally {
    Restore-BabyPlanEnvironment -Original $targetAppBackup
  }
  $environmentCreated = $true
  ($newEnvironment.GetEnumerator() |
      Sort-Object Name |
      ForEach-Object { "$($_.Name)=$($_.Value)" }) -join "`n" |
    Set-Content -LiteralPath $restoreEnvironmentPath -Encoding UTF8
  Protect-BabyPlanSecretFile -Path $restoreEnvironmentPath

  $report = [ordered]@{
    format = 'babyplan-restore-report-v2'
    restoredAt = (Get-Date).ToUniversalTime().ToString('o')
    backupPath = $sourceBackup
    targetDatabase = $TargetDatabase
    environmentFile = $restoreEnvironmentPath
    mediaPath = $mediaTarget
    recoveryOutboxPath = $recoveryOutboxTarget
    migrations = $restoredMigrations
    sourcePostgresVersion = $sourcePostgresVersion
    restoreServerVersion = $restoreServerVersion
    databaseSha256 = $actualDumpHash
    mediaFileCount = $postReplayDigest.fileCount
    mediaDigestSha256 = $postReplayDigest.digestSha256
    mediaDigestBeforeReplay = $restoredMedia.digestSha256
    deletionEvents = $replay.total
    deletionEventsReapplied = $replay.reapplied
    elapsedSeconds = [Math]::Round($stopwatch.Elapsed.TotalSeconds, 2)
    backupAgeSeconds = [Math]::Round(([DateTimeOffset]::UtcNow - $backupTimestamp).TotalSeconds, 2)
  }
  $reportPath = Join-Path $restoreBase "restore-$TargetDatabase.json"
  $report | ConvertTo-Json -Depth 6 |
    Set-Content -LiteralPath $reportPath -Encoding UTF8
  Write-Host "恢复完成：数据库 $TargetDatabase，媒体 $mediaTarget" -ForegroundColor Green
  return [pscustomobject]@{
    targetDatabase = $TargetDatabase
    environmentFile = $restoreEnvironmentPath
    mediaPath = $mediaTarget
    recoveryOutboxPath = $recoveryOutboxTarget
    reportPath = $reportPath
    migrations = $restoredMigrations
    mediaFiles = $postReplayDigest.fileCount
  }
} catch {
  if ($databaseCreated -and -not $KeepFailedDatabase -and $dropdb) {
    & $dropdb --if-exists $TargetDatabase 2>$null
  }
  if ($environmentCreated -and (Test-Path -LiteralPath $restoreEnvironmentPath)) {
    Remove-Item -LiteralPath $restoreEnvironmentPath -Force
  }
  if ($mediaCreated -and (Test-Path -LiteralPath $mediaTarget)) {
    $safeMedia = Assert-PathInside -Path $mediaTarget -Parent $restoreBase
    Remove-Item -LiteralPath $safeMedia -Recurse -Force
  }
  if ($recoveryCreated -and (Test-Path -LiteralPath $recoveryOutboxTarget)) {
    $safeRecovery = Assert-PathInside `
      -Path $recoveryOutboxTarget `
      -Parent $restoreBase
    Remove-Item -LiteralPath $safeRecovery -Recurse -Force
  }
  throw
} finally {
  if ($adminBackup.Count) {
    Restore-BabyPlanEnvironment -Original $adminBackup
  }
}
