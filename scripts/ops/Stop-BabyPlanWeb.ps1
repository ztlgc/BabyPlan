[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [string]$EnvironmentFile,
  [int]$TimeoutSeconds = 15
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'BabyPlanOps.Common.psm1') -Force

$environmentPath = Get-NormalizedFullPath -Path $EnvironmentFile
$pidPath = Join-Path (Split-Path -Parent $environmentPath) '../runtime/web.pid'
$pidPath = Get-NormalizedFullPath -Path $pidPath
if (-not (Test-Path -LiteralPath $pidPath -PathType Leaf)) {
  Write-Host '没有找到网页 PID 文件，视为已经停止。'
  return
}
$rawPid = (Get-Content -LiteralPath $pidPath -Raw).Trim()
if ($rawPid -notmatch '^\d+$') {
  throw "PID 文件格式无效：$pidPath"
}
$process = Get-Process -Id ([int]$rawPid) -ErrorAction SilentlyContinue
if (-not $process) {
  Remove-Item -LiteralPath $pidPath -Force
  Write-Host 'PID 对应网页进程已不存在，已清理旧 PID 文件。'
  return
}
$processInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$rawPid"
$expectedEntryPoint = (
  Resolve-Path (Join-Path $PSScriptRoot '../../apps/web/server.mjs')
).Path
$commandLine = [string]$processInfo.CommandLine
if (
  $processInfo.Name -ne 'node.exe' -or
  $commandLine.IndexOf(
    $expectedEntryPoint,
    [StringComparison]::OrdinalIgnoreCase
  ) -lt 0
) {
  throw "PID $rawPid 不是本项目网页进程，拒绝停止。"
}

$values = Read-BabyPlanEnvFile -Path $environmentPath
$hostName = if ($values.ContainsKey('WEB_HOST')) { $values.WEB_HOST } else { '127.0.0.1' }
$port = if ($values.ContainsKey('WEB_PORT')) { [int]$values.WEB_PORT } else { 4174 }
Stop-Process -Id $process.Id
Wait-Process -Id $process.Id -Timeout $TimeoutSeconds -ErrorAction SilentlyContinue
if (Get-Process -Id $process.Id -ErrorAction SilentlyContinue) {
  throw "网页进程 $($process.Id) 在 $TimeoutSeconds 秒内未停止。"
}
Remove-Item -LiteralPath $pidPath -Force
$portDeadline = (Get-Date).AddSeconds($TimeoutSeconds)
while (
  (Test-BabyPlanApiOnline -HostName $hostName -Port $port) -and
  (Get-Date) -lt $portDeadline
) {
  Start-Sleep -Milliseconds 250
}
if (Test-BabyPlanApiOnline -HostName $hostName -Port $port) {
  throw "网页 PID 已退出，但端口 $port 仍在监听；请人工确认其他服务。"
}
Write-Host "家长网页已停止，端口 $port 不再监听。" -ForegroundColor Green
