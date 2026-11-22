[CmdletBinding()]
param(
  [string]$Destination = (Join-Path (Get-Location) '.work/private'),
  [string]$DatabaseHost = '127.0.0.1',
  [int]$DatabasePort = 5432,
  [string]$DatabaseName = 'babyplan',
  [string]$DatabaseUser = 'babyplan',
  [string]$DatabasePassword,
  [string]$ApiHost = '127.0.0.1',
  [int]$ApiPort = 4318,
  [string]$WebHost = '127.0.0.1',
  [int]$WebPort = 4174,
  [string]$ClientApiBaseUrl,
  [string]$PublicBaseUrl,
  [switch]$DevelopmentTrial,
  [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'BabyPlanOps.Common.psm1') -Force

$destinationPath = Get-NormalizedFullPath -Path $Destination
if (Test-Path -LiteralPath $destinationPath) {
  $existing = @(Get-ChildItem -LiteralPath $destinationPath -Force)
  if ($existing.Count -gt 0 -and -not $Force) {
    throw "目标目录非空：$destinationPath。确认要补齐目录时才可使用 -Force。"
  }
}
foreach ($directory in @(
    $destinationPath,
    (Join-Path $destinationPath 'config'),
    (Join-Path $destinationPath 'data/media'),
    (Join-Path $destinationPath 'data/backups'),
    (Join-Path $destinationPath 'data/restores'),
    (Join-Path $destinationPath 'data/recovery-outbox'),
    (Join-Path $destinationPath 'logs'),
    (Join-Path $destinationPath 'runtime')
  )) {
  New-Item -ItemType Directory -Path $directory -Force | Out-Null
}
Protect-BabyPlanSecretDirectory -Path $destinationPath
$environmentPath = Join-Path $destinationPath 'config/babyplan.env'
if (Test-Path -LiteralPath $environmentPath) {
  throw "环境文件已存在，任何选项都不会覆盖：$environmentPath"
}
if (-not $DatabasePassword) {
  $randomBytes = New-Object byte[] 32
  [Security.Cryptography.RandomNumberGenerator]::Fill($randomBytes)
  $DatabasePassword = [Convert]::ToBase64String($randomBytes).TrimEnd(
    '='
  ).Replace('+', '-').Replace('/', '_')
}
if ($DatabasePassword.Length -lt 20) {
  throw '数据库口令至少需要 20 个字符。'
}
if ($DatabaseHost -notmatch '^[A-Za-z0-9.:-]+$') {
  throw '数据库主机格式无效。'
}
if ($DatabasePort -lt 1 -or $DatabasePort -gt 65535) {
  throw '数据库端口无效。'
}
if ($ApiHost -notmatch '^[A-Za-z0-9.:-]+$') {
  throw 'API_HOST 格式无效。'
}
if ($ApiPort -lt 1 -or $ApiPort -gt 65535) {
  throw 'API 端口无效。'
}
if ($WebHost -notmatch '^[A-Za-z0-9.:-]+$') {
  throw 'WEB_HOST 格式无效。'
}
if ($WebPort -lt 1 -or $WebPort -gt 65535) {
  throw '网页端口无效。'
}
if (-not $ClientApiBaseUrl) {
  $ClientApiBaseUrl = "http://127.0.0.1:$ApiPort"
}
$clientApiUri = $null
if (
  -not [Uri]::TryCreate(
    $ClientApiBaseUrl,
    [UriKind]::Absolute,
    [ref]$clientApiUri
  ) -or
  $clientApiUri.Scheme -notin @('http', 'https') -or
  -not $clientApiUri.Host -or
  $clientApiUri.UserInfo -or
  $clientApiUri.Query -or
  $clientApiUri.Fragment
) {
  throw '客户端 API 地址必须是不含凭证、查询和片段的 HTTP(S) 地址。'
}
if (-not $PublicBaseUrl) {
  $PublicBaseUrl = "http://127.0.0.1:$WebPort"
}
$publicUri = $null
if (
  -not [Uri]::TryCreate(
    $PublicBaseUrl,
    [UriKind]::Absolute,
    [ref]$publicUri
  ) -or
  $publicUri.Scheme -notin @('http', 'https') -or
  -not $publicUri.Host -or
  $publicUri.UserInfo -or
  $publicUri.Query -or
  $publicUri.Fragment
) {
  throw 'PUBLIC_BASE_URL 必须是不含凭证、查询和片段的 HTTP(S) 地址。'
}
if ($DatabaseName -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') {
  throw '数据库名格式无效。'
}
if ($DatabaseUser -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') {
  throw '数据库用户名格式无效。'
}

$encodedUser = [Uri]::EscapeDataString($DatabaseUser)
$encodedPassword = [Uri]::EscapeDataString($DatabasePassword)
$encodedDatabase = [Uri]::EscapeDataString($DatabaseName)
$databaseUrl =
  "postgresql://${encodedUser}:${encodedPassword}@${DatabaseHost}:${DatabasePort}/${encodedDatabase}"
$mediaPath = (Join-Path $destinationPath 'data/media').Replace('\', '/')
$backupPath = (Join-Path $destinationPath 'data/backups').Replace('\', '/')
$restorePath = (Join-Path $destinationPath 'data/restores').Replace('\', '/')
$recoveryOutboxPath = (
  Join-Path $destinationPath 'data/recovery-outbox'
).Replace('\', '/')
$deletionJournalPath = (Join-Path $destinationPath 'data/deletion-journal').Replace('\', '/')
$serverEnvironment = if ($DevelopmentTrial) { 'development' } else { 'production' }
$contentEnvironment = if ($DevelopmentTrial) { 'development' } else { 'private_trial' }
$content = @"
# 自动生成的私有部署配置。请备份并限制访问，不要提交到版本库。
NODE_ENV=$serverEnvironment
CONTENT_ENVIRONMENT=$contentEnvironment
API_HOST=$ApiHost
API_PORT=$ApiPort
PUBLIC_BASE_URL=$($publicUri.AbsoluteUri.TrimEnd('/'))
DATABASE_URL=$databaseUrl
DB_POOL_MAX=8
LOG_LEVEL=info
BABYPLAN_INITIAL_CREDENTIAL=
MEDIA_ROOT=$mediaPath
MEDIA_STORAGE_PATH=$mediaPath
BACKUP_ROOT=$backupPath
RESTORE_ROOT=$restorePath
RECOVERY_OUTBOX_ROOT=$recoveryOutboxPath
DELETION_JOURNAL_ROOT=$deletionJournalPath
BABYPLAN_API_BASE_URL=$($clientApiUri.AbsoluteUri.TrimEnd('/'))
WEB_HOST=$WebHost
WEB_PORT=$WebPort
BABYPLAN_API_TARGET=http://127.0.0.1:$ApiPort
"@
Set-Content -LiteralPath $environmentPath -Value $content -Encoding UTF8
Protect-BabyPlanSecretFile -Path $environmentPath

$templatePath = Join-Path $destinationPath 'config/runtime.json'
[ordered]@{
  createdAt = (Get-Date).ToUniversalTime().ToString('o')
  environmentFile = $environmentPath
  databaseName = $DatabaseName
  postgresHint = '请用数据库管理员创建角色与空数据库；本脚本不连接或修改任何数据库。'
  mediaDirectory = Join-Path $destinationPath 'data/media'
  backupDirectory = Join-Path $destinationPath 'data/backups'
  restoreDirectory = Join-Path $destinationPath 'data/restores'
  recoveryOutboxDirectory = Join-Path $destinationPath 'data/recovery-outbox'
  deletionJournalDirectory = Join-Path $destinationPath 'data/deletion-journal'
  clientApiBaseUrl = $clientApiUri.AbsoluteUri.TrimEnd('/')
  runtimeDirectory = Join-Path $destinationPath 'runtime'
  logDirectory = Join-Path $destinationPath 'logs'
} | ConvertTo-Json -Depth 4 |
  Set-Content -LiteralPath $templatePath -Encoding UTF8

Write-Host '私有部署目录已创建。' -ForegroundColor Green
Write-Host "环境文件：$environmentPath"
Write-Host '下一步：创建专用数据库角色与空数据库，运行 Deploy-BabyPlan.ps1。'
