[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [string]$EnvironmentFile,
  [string]$ArtifactRoot,
  [string]$AdminDatabaseUrlEnvironmentVariable = 'BABYPLAN_RESTORE_ADMIN_DATABASE_URL',
  [switch]$KeepRestoredDatabase
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'BabyPlanOps.Common.psm1') -Force

if ($AdminDatabaseUrlEnvironmentVariable -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') {
  throw '管理员连接环境变量名格式无效。'
}
if (-not [Environment]::GetEnvironmentVariable(
    $AdminDatabaseUrlEnvironmentVariable,
    'Process'
  )) {
  throw "请通过当前进程环境变量 $AdminDatabaseUrlEnvironmentVariable 提供恢复管理员连接。"
}

trap {
  $originalError = $_
  $restoreVariable = Get-Variable -Name restoreResult -ErrorAction SilentlyContinue
  if (
    -not $KeepRestoredDatabase -and
    $restoreVariable -and
    $restoreVariable.Value -and
    $restoreVariable.Value.targetDatabase -match '^babyplan_restore_'
  ) {
    try {
      $cleanupAdmin = [Environment]::GetEnvironmentVariable(
        $AdminDatabaseUrlEnvironmentVariable,
        'Process'
      )
      $cleanupBackup = Set-PostgresConnectionEnvironment `
        -DatabaseUrl $cleanupAdmin
      try {
        $cleanupDropdb = Resolve-PostgresTool -Name 'dropdb'
        & $cleanupDropdb --if-exists `
          $restoreVariable.Value.targetDatabase 2>$null | Out-Null
      } finally {
        Restore-BabyPlanEnvironment -Original $cleanupBackup
      }
    } catch {
      Write-Warning '失败清理临时恢复数据库未完成，请人工核对。'
    }
    try {
      $cleanupMedia = Assert-PathInside `
        -Path $restoreVariable.Value.mediaPath `
        -Parent $restoreRoot
      if (Test-Path -LiteralPath $cleanupMedia) {
        Remove-Item -LiteralPath $cleanupMedia -Recurse -Force
      }
    } catch {
      Write-Warning '失败清理恢复媒体目录未完成，请人工核对。'
    }
    try {
      $cleanupRecovery = Assert-PathInside `
        -Path $restoreVariable.Value.recoveryOutboxPath `
        -Parent $restoreRoot
      if (Test-Path -LiteralPath $cleanupRecovery) {
        Remove-Item -LiteralPath $cleanupRecovery -Recurse -Force
      }
    } catch {
      Write-Warning '失败清理恢复账号投递目录未完成，请人工核对。'
    }
  }
  throw $originalError
}

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$workRoot = Get-NormalizedFullPath -Path (Join-Path $repositoryRoot '.work')
if (-not $ArtifactRoot) {
  $ArtifactRoot = Join-Path $workRoot 'ops-backup-restore-drill'
}
$artifacts = Get-NormalizedFullPath -Path $ArtifactRoot
Assert-PathInside -Path $artifacts -Parent $workRoot | Out-Null
if (Test-Path -LiteralPath $artifacts) {
  throw "演练目录已存在，请换一个 -ArtifactRoot：$artifacts"
}
$source = Read-BabyPlanEnvFile -Path $EnvironmentFile
if (-not $source.ContainsKey('DATABASE_URL')) {
  throw '源环境缺少 DATABASE_URL。'
}
$sourceApiHost = if ($source.ContainsKey('API_HOST')) {
  $source.API_HOST
} else {
  '127.0.0.1'
}
$sourceApiPort = if ($source.ContainsKey('API_PORT')) {
  [int]$source.API_PORT
} else {
  4318
}
if (Test-BabyPlanApiOnline -HostName $sourceApiHost -Port $sourceApiPort) {
  throw '源环境 API 正在监听。演练会读取源数据库，请先停止 API 和网页。'
}
$mediaSource = Join-Path $artifacts 'media-source'
$backupRoot = Join-Path $artifacts 'backups'
$restoreRoot = Join-Path $artifacts 'restores'
$configRoot = Join-Path $artifacts 'config'
New-Item -ItemType Directory -Path (Join-Path $mediaSource 'nested') -Force |
  Out-Null
New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
New-Item -ItemType Directory -Path $restoreRoot -Force | Out-Null
New-Item -ItemType Directory -Path $configRoot -Force | Out-Null
Set-Content -LiteralPath (Join-Path $mediaSource 'sample.txt') `
  -Value 'BabyPlan backup and restore drill' -Encoding UTF8
Set-Content -LiteralPath (Join-Path $mediaSource 'nested/sample.bin') `
  -Value ([byte[]](1, 2, 3, 4, 5, 8, 13, 21)) -AsByteStream

$drillValues = [ordered]@{}
foreach ($entry in $source.GetEnumerator()) {
  $drillValues[$entry.Key] = $entry.Value
}
$drillValues.MEDIA_ROOT = $mediaSource.Replace('\', '/')
$drillValues.MEDIA_STORAGE_PATH = $mediaSource.Replace('\', '/')
$drillValues.BACKUP_ROOT = $backupRoot.Replace('\', '/')
$drillValues.RESTORE_ROOT = $restoreRoot.Replace('\', '/')
$drillValues.API_HOST = '127.0.0.1'
$drillValues.API_PORT = '43993'
$drillEnvironment = Join-Path $configRoot 'babyplan.env'
($drillValues.GetEnumerator() |
    Sort-Object Name |
    ForEach-Object { "$($_.Name)=$($_.Value)" }) -join "`n" |
  Set-Content -LiteralPath $drillEnvironment -Encoding UTF8
Protect-BabyPlanSecretFile -Path $drillEnvironment

$backupResult = & (Join-Path $PSScriptRoot 'Backup-BabyPlan.ps1') `
  -EnvironmentFile $drillEnvironment
if ($backupResult.consistency -ne 'api_stopped_verified') {
  throw '备份没有记录为 API 停止后的一致性快照。'
}
$restoreResult = & (Join-Path $PSScriptRoot 'Restore-BabyPlan.ps1') `
  -EnvironmentFile $drillEnvironment `
  -BackupPath $backupResult.path `
  -AdminDatabaseUrlEnvironmentVariable $AdminDatabaseUrlEnvironmentVariable `
  -ConfirmRestore
if ($restoreResult.targetDatabase -notmatch '^babyplan_restore_') {
  throw '恢复目标不是安全前缀的临时数据库。'
}

function Get-CountSnapshot {
  param(
    [Parameter(Mandatory)]
    [string]$DatabaseUrl
  )

  $backup = Set-PostgresConnectionEnvironment -DatabaseUrl $DatabaseUrl
  try {
    $psql = Resolve-PostgresTool -Name 'psql'
    $query = @'
SELECT
  table_name,
  (xpath(
    '/row/c/text()',
    query_to_xml(
      format('SELECT count(*) AS c FROM %I.%I', table_schema, table_name),
      false,
      true,
      ''
    )
  ))[1]::text::bigint
FROM information_schema.tables
WHERE table_schema='app' AND table_type='BASE TABLE'
ORDER BY table_name;
'@
    $output = & $psql --no-psqlrc --tuples-only --no-align `
      --field-separator='|' `
      --command $query
    if ($LASTEXITCODE -ne 0) {
      throw "读取数据库计数失败（退出码 $LASTEXITCODE）"
    }
    $counts = [ordered]@{}
    foreach ($line in $output) {
      $text = ([string]$line).Trim()
      if (-not $text) { continue }
      $parts = $text.Split('|', 2)
      if ($parts.Count -ne 2 -or $parts[0] -notmatch '^[a-z0-9_]+$') {
        throw '读取数据库表计数时返回了无效行。'
      }
      $counts[$parts[0]] = [long]$parts[1]
    }
    return [pscustomobject]$counts
  } finally {
    Restore-BabyPlanEnvironment -Original $backup
  }
}

$sourceCounts = Get-CountSnapshot -DatabaseUrl $source.DATABASE_URL
$restoredReport = Get-Content -LiteralPath $restoreResult.reportPath -Raw |
  ConvertFrom-Json
$builder = [UriBuilder]($source.DATABASE_URL)
$builder.Path = "/$($restoreResult.targetDatabase)"
$restoredCounts = Get-CountSnapshot -DatabaseUrl $builder.Uri.AbsoluteUri
$countComparison = [ordered]@{}
$countsMatch = $true
foreach ($property in $sourceCounts.PSObject.Properties.Name) {
  $same = [long]$sourceCounts.$property -eq [long]$restoredCounts.$property
  $countComparison[$property] = [ordered]@{
    source = [long]$sourceCounts.$property
    restored = [long]$restoredCounts.$property
    match = $same
  }
  if (-not $same) { $countsMatch = $false }
}
$unexpectedRestoredTables = @(
  $restoredCounts.PSObject.Properties.Name |
    Where-Object { -not $sourceCounts.PSObject.Properties.Name.Contains($_) }
)
if ($unexpectedRestoredTables.Count) {
  throw "恢复库包含源库没有的 app 表：$($unexpectedRestoredTables -join ',')"
}
if (-not $countsMatch) {
  throw "恢复后的数据计数不一致。请检查 $($restoreResult.reportPath)"
}
$versionBackup = Set-PostgresConnectionEnvironment `
  -DatabaseUrl $source.DATABASE_URL
try {
  $psql = Resolve-PostgresTool -Name 'psql'
  $identityOutput = & $psql --no-psqlrc --tuples-only --no-align `
    --command @'
SELECT
  current_setting('server_version'),
  current_user,
  r.rolsuper,
  r.rolcreatedb
FROM pg_roles r
WHERE r.rolname=current_user;
'@
  if ($LASTEXITCODE -ne 0) {
    throw "读取 PostgreSQL 与应用角色信息失败（退出码 $LASTEXITCODE）"
  }
  $identityParts = ((@($identityOutput) -join '').Trim()).Split('|', 4)
  if ($identityParts.Count -ne 4) {
    throw '读取 PostgreSQL 与应用角色信息时返回了无效结果。'
  }
  $postgresVersion = $identityParts[0]
  $applicationRole = $identityParts[1]
  $applicationRoleSuperuser = $identityParts[2] -eq 't'
  $applicationRoleCanCreateDatabase = $identityParts[3] -eq 't'
} finally {
  Restore-BabyPlanEnvironment -Original $versionBackup
}
$mediaDigest = Get-TreeDigest -Path $restoreResult.mediaPath
if (
  $mediaDigest.fileCount -ne $backupResult.mediaFiles -or
  $mediaDigest.digestSha256 -ne $backupResult.mediaDigestSha256
) {
  throw '恢复后的媒体摘要不一致。'
}
$restoredRecoveryOutbox = Assert-PathInside `
  -Path $restoreResult.recoveryOutboxPath `
  -Parent $restoreRoot
if (-not (Test-Path -LiteralPath $restoredRecoveryOutbox -PathType Container)) {
  throw '恢复后没有独立的账号恢复投递目录。'
}
if (@(Get-ChildItem -LiteralPath $restoredRecoveryOutbox -Force).Count -ne 0) {
  throw '新恢复环境的账号恢复投递目录不是空目录。'
}

$databaseDropped = $false
if (-not $KeepRestoredDatabase) {
  $adminDatabaseUrl = [Environment]::GetEnvironmentVariable(
    $AdminDatabaseUrlEnvironmentVariable,
    'Process'
  )
  $adminBackup = Set-PostgresConnectionEnvironment `
    -DatabaseUrl $adminDatabaseUrl
  try {
    $dropdb = Resolve-PostgresTool -Name 'dropdb'
    Invoke-CheckedProcess -FilePath $dropdb `
      -ArgumentList @('--if-exists', $restoreResult.targetDatabase) `
      -FailureMessage '清理临时恢复数据库失败' `
      -SuppressOutput
    $databaseDropped = $true
  } finally {
    Restore-BabyPlanEnvironment -Original $adminBackup
  }
}

$evidence = [ordered]@{
  format = 'babyplan-backup-restore-evidence-v1'
  executedAt = (Get-Date).ToUniversalTime().ToString('o')
  result = 'passed'
  backupPath = $backupResult.path
  backupConsistency = $backupResult.consistency
  databaseSha256 = $backupResult.databaseSha256
  mediaFiles = $backupResult.mediaFiles
  mediaDigestSha256 = $backupResult.mediaDigestSha256
  restoredDatabase = $restoreResult.targetDatabase
  restoredMigrations = @($restoreResult.migrations)
  restoredRecoveryOutboxPath = $restoredRecoveryOutbox
  restoredRecoveryOutboxCreated = $true
  postgresVersion = $postgresVersion
  applicationRole = $applicationRole
  applicationRoleSuperuser = $applicationRoleSuperuser
  applicationRoleCanCreateDatabase = $applicationRoleCanCreateDatabase
  schemaTableCount = @($sourceCounts.PSObject.Properties).Count
  countComparison = $countComparison
  temporaryDatabaseDropped = $databaseDropped
  adminCredentialSource = "当前进程环境变量 $AdminDatabaseUrlEnvironmentVariable（未写入证据）"
  scope = '隔离开发 PostgreSQL 集群内由独立管理员连接新建临时数据库并恢复，不代表生产服务器恢复。'
}
$evidencePath = Join-Path $artifacts 'evidence.json'
$evidence | ConvertTo-Json -Depth 8 |
  Set-Content -LiteralPath $evidencePath -Encoding UTF8
Write-Host "备份恢复演练通过：$evidencePath" -ForegroundColor Green
return [pscustomobject]@{
  evidencePath = $evidencePath
  backupPath = $backupResult.path
  restoredDatabase = $restoreResult.targetDatabase
  temporaryDatabaseDropped = $databaseDropped
  result = 'passed'
}
