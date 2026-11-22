[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [string]$EnvironmentFile
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

try {
  & (Join-Path $PSScriptRoot 'Start-BabyPlanApi.ps1') `
    -EnvironmentFile $EnvironmentFile
  & (Join-Path $PSScriptRoot 'Start-BabyPlanWeb.ps1') `
    -EnvironmentFile $EnvironmentFile
  Write-Host 'BabyPlan API 与家长网页均已启动。' -ForegroundColor Green
} catch {
  try {
    & (Join-Path $PSScriptRoot 'Stop-BabyPlanWeb.ps1') `
      -EnvironmentFile $EnvironmentFile
  } catch {
    # 保留原始启动错误。
  }
  try {
    & (Join-Path $PSScriptRoot 'Stop-BabyPlanApi.ps1') `
      -EnvironmentFile $EnvironmentFile
  } catch {
    # 保留原始启动错误。
  }
  throw
}
