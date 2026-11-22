[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [string]$EnvironmentFile
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'BabyPlanOps.Common.psm1') -Force

$values = Read-BabyPlanEnvFile -Path $EnvironmentFile
$apiHost = if ($values.ContainsKey('API_HOST')) { $values.API_HOST } else { '127.0.0.1' }
$apiPort = if ($values.ContainsKey('API_PORT')) { [int]$values.API_PORT } else { 4318 }
$webHost = if ($values.ContainsKey('WEB_HOST')) { $values.WEB_HOST } else { '127.0.0.1' }
$webPort = if ($values.ContainsKey('WEB_PORT')) { [int]$values.WEB_PORT } else { 4174 }
$apiWasOnline = Test-BabyPlanApiOnline -HostName $apiHost -Port $apiPort
$webWasOnline = Test-BabyPlanApiOnline -HostName $webHost -Port $webPort

$backup = $null
$primaryFailure = $null
$recoveryFailures = [System.Collections.Generic.List[string]]::new()
try {
  & (Join-Path $PSScriptRoot 'Stop-BabyPlanWeb.ps1') `
    -EnvironmentFile $EnvironmentFile
  & (Join-Path $PSScriptRoot 'Stop-BabyPlanApi.ps1') `
    -EnvironmentFile $EnvironmentFile
  $backup = & (Join-Path $PSScriptRoot 'Backup-BabyPlan.ps1') `
    -EnvironmentFile $EnvironmentFile
} catch {
  $primaryFailure = $_
} finally {
  if ($apiWasOnline) {
    try {
      & (Join-Path $PSScriptRoot 'Start-BabyPlanApi.ps1') `
        -EnvironmentFile $EnvironmentFile
    } catch {
      $recoveryFailures.Add("API 恢复启动失败：$($_.Exception.Message)")
    }
  }
  if ($webWasOnline) {
    try {
      & (Join-Path $PSScriptRoot 'Start-BabyPlanWeb.ps1') `
        -EnvironmentFile $EnvironmentFile
    } catch {
      $recoveryFailures.Add("网页恢复启动失败：$($_.Exception.Message)")
    }
  }
}

if ($primaryFailure -and $recoveryFailures.Count) {
  throw (
    "维护备份失败：$($primaryFailure.Exception.Message)；" +
    "服务恢复也不完整：$($recoveryFailures -join '；')"
  )
}
if ($primaryFailure) {
  throw $primaryFailure
}
if ($recoveryFailures.Count) {
  throw "备份已完成，但服务恢复不完整：$($recoveryFailures -join '；')"
}
return $backup
