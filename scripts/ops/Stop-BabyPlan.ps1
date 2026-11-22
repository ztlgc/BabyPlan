[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [string]$EnvironmentFile
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$failure = $null
try {
  & (Join-Path $PSScriptRoot 'Stop-BabyPlanWeb.ps1') `
    -EnvironmentFile $EnvironmentFile
} catch {
  $failure = $_
}
try {
  & (Join-Path $PSScriptRoot 'Stop-BabyPlanApi.ps1') `
    -EnvironmentFile $EnvironmentFile
} catch {
  if (-not $failure) { $failure = $_ }
}
if ($failure) { throw $failure }
Write-Host 'BabyPlan API 与家长网页均已停止。' -ForegroundColor Green
