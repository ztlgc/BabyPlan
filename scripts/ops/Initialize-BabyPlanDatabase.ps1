[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [string]$EnvironmentFile,
  [switch]$RotatePassword
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'BabyPlanOps.Common.psm1') -Force

$adminDatabaseUrl = $env:BABYPLAN_ADMIN_DATABASE_URL
if (-not $adminDatabaseUrl) {
  throw '请通过当前进程环境变量 BABYPLAN_ADMIN_DATABASE_URL 提供数据库管理员连接，避免写入命令历史。'
}
$target = Read-BabyPlanEnvFile -Path $EnvironmentFile
if (-not $target.ContainsKey('DATABASE_URL')) {
  throw '环境文件缺少 DATABASE_URL。'
}

$adminBackup = @{}
$targetBackup = @{}
try {
  $targetUri = [Uri]$target.DATABASE_URL
  $roleParts = $targetUri.UserInfo.Split(':', 2)
  if (
    $targetUri.Scheme -notin @('postgres', 'postgresql') -or
    -not $targetUri.Host -or
    $roleParts.Count -ne 2 -or
    -not $roleParts[0] -or
    -not $roleParts[1]
  ) {
    throw '环境文件中的 DATABASE_URL 缺少有效的 PostgreSQL 主机、用户名或口令。'
  }
  $roleName = [Uri]::UnescapeDataString($roleParts[0])
  $rolePassword = [Uri]::UnescapeDataString($roleParts[1])
  $databaseName = [Uri]::UnescapeDataString(
    $targetUri.AbsolutePath.TrimStart('/')
  )
  if ($roleName -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') {
    throw '数据库角色名格式无效。'
  }
  if ($databaseName -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') {
    throw '数据库名格式无效。'
  }
  $roleLiteral = $roleName.Replace("'", "''")
  $databaseLiteral = $databaseName.Replace("'", "''")
  $passwordLiteral = $rolePassword.Replace("'", "''")

  $adminBackup = Set-PostgresConnectionEnvironment -DatabaseUrl $adminDatabaseUrl
  $env:PGDATABASE = 'postgres'
  $psql = Resolve-PostgresTool -Name 'psql'
  $roleExists = & $psql --no-psqlrc --tuples-only --no-align `
    --command "SELECT 1 FROM pg_roles WHERE rolname='$roleLiteral'"
  if ($LASTEXITCODE -ne 0) {
    throw "检查数据库角色失败（退出码 $LASTEXITCODE）"
  }
  $databaseExists = & $psql --no-psqlrc --tuples-only --no-align `
    --command "SELECT 1 FROM pg_database WHERE datname='$databaseLiteral'"
  if ($LASTEXITCODE -ne 0) {
    throw "检查数据库失败（退出码 $LASTEXITCODE）"
  }
  $statements = [System.Collections.Generic.List[string]]::new()
  if (-not (($roleExists -join '').Trim())) {
    $statements.Add(
      "CREATE ROLE ""$roleName"" LOGIN PASSWORD '$passwordLiteral';"
    )
  } elseif ($RotatePassword) {
    $statements.Add(
      "ALTER ROLE ""$roleName"" WITH LOGIN PASSWORD '$passwordLiteral';"
    )
  }
  if (-not (($databaseExists -join '').Trim())) {
    $statements.Add(
      "CREATE DATABASE ""$databaseName"" OWNER ""$roleName"";"
    )
  }
  if ($statements.Count) {
    $sql = ($statements -join "`n") + "`n"
    $sql | & $psql --no-psqlrc --set ON_ERROR_STOP=1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
      throw "创建数据库角色或数据库失败（退出码 $LASTEXITCODE）"
    }
  }

  Restore-BabyPlanEnvironment -Original $adminBackup
  $targetBackup = Set-PostgresConnectionEnvironment -DatabaseUrl $target.DATABASE_URL
  Invoke-CheckedProcess -FilePath $psql `
    -ArgumentList @(
      '--no-psqlrc',
      '--set',
      'ON_ERROR_STOP=1',
      '--command',
      'SELECT 1'
    ) `
    -FailureMessage '目标数据库角色无法连接；如确需更新口令，请显式使用 -RotatePassword' `
    -SuppressOutput
  Write-Host "数据库角色和数据库可用：$databaseName" -ForegroundColor Green
} finally {
  if ($targetBackup.Count) {
    Restore-BabyPlanEnvironment -Original $targetBackup
  }
  if ($adminBackup.Count) {
    Restore-BabyPlanEnvironment -Original $adminBackup
  }
}
