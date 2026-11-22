[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [string]$EnvironmentFile,
  [switch]$SkipInstall,
  [string]$ContentPackage,
  [ValidateSet('development', 'private_trial', 'public')]
  [string]$ContentEnvironment = 'private_trial',
  [string]$PublishReleaseId,
  [switch]$SuppressContentWarning
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'BabyPlanOps.Common.psm1') -Force

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$apiRoot = Join-Path $repositoryRoot 'services/api'
$values = Read-BabyPlanEnvFile -Path $EnvironmentFile
if (-not $values.ContainsKey('DATABASE_URL')) {
  throw '环境文件缺少 DATABASE_URL。'
}
if (
  -not $values.ContainsKey('MEDIA_ROOT') -or
  -not $values.MEDIA_ROOT
) {
  throw '环境文件缺少 MEDIA_ROOT；请使用新版初始化脚本或显式补齐。'
}
if (-not $values.ContainsKey('PUBLIC_BASE_URL') -or -not $values.PUBLIC_BASE_URL) {
  throw '环境文件缺少 PUBLIC_BASE_URL；短期媒体链接需要明确外部访问地址。'
}
$mediaRootPath = Get-NormalizedFullPath -Path $values.MEDIA_ROOT
if (
  $values.ContainsKey('MEDIA_STORAGE_PATH') -and
  -not (Get-NormalizedFullPath -Path $values.MEDIA_STORAGE_PATH).Equals(
    $mediaRootPath,
    [StringComparison]::OrdinalIgnoreCase
  )
) {
  throw 'MEDIA_ROOT 与 MEDIA_STORAGE_PATH 指向不同目录，拒绝部署。'
}
if (-not (Test-Path -LiteralPath $mediaRootPath -PathType Container)) {
  throw "MEDIA_ROOT 目录不存在：$mediaRootPath"
}
$recoveryOutboxPath = $null
if (
  $values.ContainsKey('RECOVERY_OUTBOX_ROOT') -and
  $values.RECOVERY_OUTBOX_ROOT
) {
  $recoveryOutboxPath = Get-NormalizedFullPath -Path $values.RECOVERY_OUTBOX_ROOT
} elseif ($values.ContainsKey('NODE_ENV') -and $values.NODE_ENV -eq 'production') {
  throw '生产环境缺少 RECOVERY_OUTBOX_ROOT；账号恢复投递目录必须单独配置。'
}
if ($recoveryOutboxPath) {
  $pathPairs = @(
    @{ Name = '媒体目录'; Path = $mediaRootPath }
  )
  if ($values.ContainsKey('BACKUP_ROOT') -and $values.BACKUP_ROOT) {
    $pathPairs += @{
      Name = '备份目录'
      Path = Get-NormalizedFullPath -Path $values.BACKUP_ROOT
    }
  }
  foreach ($pair in $pathPairs) {
    if (Test-PathTreesOverlap -Path $recoveryOutboxPath -OtherPath $pair.Path) {
      throw "RECOVERY_OUTBOX_ROOT 必须与$($pair.Name)完全分离。"
    }
  }
  if (-not (Test-Path -LiteralPath $recoveryOutboxPath -PathType Container)) {
    throw "RECOVERY_OUTBOX_ROOT 目录不存在：$recoveryOutboxPath"
  }
}
$publicUri = $null
if (
  -not [Uri]::TryCreate(
    $values.PUBLIC_BASE_URL,
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

$environmentBackup = Import-BabyPlanEnvironment -Values $values
$postgresBackup = @{}
try {
  $postgresBackup = Set-PostgresConnectionEnvironment -DatabaseUrl $values.DATABASE_URL
  Push-Location $apiRoot
  try {
    if (-not $SkipInstall) {
      Invoke-CheckedProcess -FilePath 'npm.cmd' -ArgumentList @('ci') `
        -FailureMessage '安装服务端依赖失败'
    }
    Invoke-CheckedProcess -FilePath 'npm.cmd' `
      -ArgumentList @('run', 'typecheck') `
      -FailureMessage '服务端类型检查失败'
    Invoke-CheckedProcess -FilePath 'npm.cmd' `
      -ArgumentList @('run', 'build') `
      -FailureMessage '服务端构建失败'
    Invoke-CheckedProcess -FilePath 'npm.cmd' `
      -ArgumentList @('run', 'db:migrate') `
      -FailureMessage '数据库迁移失败'
    if ($ContentPackage) {
      $contentPath = Get-NormalizedFullPath -Path $ContentPackage -BasePath $repositoryRoot
      if (-not (Test-Path -LiteralPath $contentPath -PathType Leaf)) {
        throw "内容包不存在：$contentPath"
      }
      Invoke-CheckedProcess -FilePath 'npm.cmd' `
        -ArgumentList @(
          'run',
          'content:import',
          '--',
          '--file',
          $contentPath,
          '--environment',
          $ContentEnvironment
        ) `
        -FailureMessage '内容包导入失败'
    }
    if ($PublishReleaseId) {
      Invoke-CheckedProcess -FilePath 'npm.cmd' `
        -ArgumentList @(
          'run',
          'content:publish',
          '--',
          '--release-id',
          $PublishReleaseId
        ) `
        -FailureMessage '内容版本发布失败'
    }
  } finally {
    Pop-Location
  }
} finally {
  if ($postgresBackup.Count) {
    Restore-BabyPlanEnvironment -Original $postgresBackup
  }
  Restore-BabyPlanEnvironment -Original $environmentBackup
}

Write-Host '服务端已构建并通过数据库迁移。' -ForegroundColor Green
if (-not $ContentPackage -and -not $SuppressContentWarning) {
  Write-Warning '本次没有导入内容包；新家庭需要先导入并发布经过审读的内容。'
}
if ($ContentPackage -and -not $PublishReleaseId) {
  Write-Warning '内容已导入但未发布；请核对审读证据后再显式提供 -PublishReleaseId。'
}
