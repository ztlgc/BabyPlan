[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [string]$EnvironmentFile,
  [int]$StartupTimeoutSeconds = 15
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'BabyPlanOps.Common.psm1') -Force

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$webRoot = Join-Path $repositoryRoot 'apps/web'
$entryPoint = Join-Path $webRoot 'server.mjs'
if (-not (Test-Path -LiteralPath $entryPoint -PathType Leaf)) {
  throw '找不到家长网页入口。'
}
$values = Read-BabyPlanEnvFile -Path $EnvironmentFile
$hostName = if ($values.ContainsKey('WEB_HOST')) { $values.WEB_HOST } else { '127.0.0.1' }
$probeHost = Get-BabyPlanProbeHost -HostName $hostName
$port = if ($values.ContainsKey('WEB_PORT')) { [int]$values.WEB_PORT } else { 4174 }
if (Test-BabyPlanApiOnline -HostName $hostName -Port $port) {
  throw "网页端口 $port 已在监听，拒绝启动第二个实例。"
}

$environmentPath = Get-NormalizedFullPath -Path $EnvironmentFile
$environmentDirectory = Split-Path -Parent $environmentPath
$runtimeDirectory = Get-NormalizedFullPath -Path (
  Join-Path $environmentDirectory '../runtime'
)
$logDirectory = Get-NormalizedFullPath -Path (
  Join-Path $environmentDirectory '../logs'
)
New-Item -ItemType Directory -Path $runtimeDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
$pidPath = Join-Path $runtimeDirectory 'web.pid'
if (Test-Path -LiteralPath $pidPath) {
  $oldPid = (Get-Content -LiteralPath $pidPath -Raw).Trim()
  if (
    $oldPid -match '^\d+$' -and
    (Get-Process -Id $oldPid -ErrorAction SilentlyContinue)
  ) {
    throw "网页 PID 文件指向仍在运行的进程 $oldPid。"
  }
  Remove-Item -LiteralPath $pidPath -Force
}

$node = (
  Get-Command node.exe -CommandType Application |
    Select-Object -First 1
).Source
$runId = "$(Get-Date -Format 'yyyyMMddTHHmmssZ')-$([Guid]::NewGuid().ToString('N').Substring(0, 8))"
$stdoutPath = Join-Path $logDirectory "web-$runId.stdout.log"
$stderrPath = Join-Path $logDirectory "web-$runId.stderr.log"
$environmentBackup = Import-BabyPlanEnvironment -Values $values
try {
  $process = Start-Process -FilePath $node `
    -ArgumentList @(
      $entryPoint,
      '--host',
      $hostName,
      '--port',
      [string]$port
    ) `
    -WorkingDirectory $webRoot `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath `
    -WindowStyle Hidden `
    -PassThru
} finally {
  Restore-BabyPlanEnvironment -Original $environmentBackup
}
Set-Content -LiteralPath $pidPath -Value $process.Id -Encoding ASCII

$startupSucceeded = $false
try {
  $deadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)
  do {
    Start-Sleep -Milliseconds 300
    if ($process.HasExited) {
      throw "家长网页启动后退出。请检查 $stderrPath。"
    }
    try {
      $response = Invoke-WebRequest `
        -Uri "http://${probeHost}:${port}/" `
        -TimeoutSec 2 `
        -UseBasicParsing
      if ($response.StatusCode -eq 200) {
        $startupSucceeded = $true
        Write-Host "家长网页已就绪，PID $($process.Id)，端口 $port。" `
          -ForegroundColor Green
        return
      }
    } catch {
      # 启动期间连接失败属于预期，继续等待。
    }
  } while ((Get-Date) -lt $deadline)

  throw "家长网页在 $StartupTimeoutSeconds 秒内未就绪。日志：$stderrPath"
} finally {
  if (-not $startupSucceeded) {
    if (-not $process.HasExited) {
      Stop-Process -Id $process.Id -ErrorAction SilentlyContinue
      Wait-Process -Id $process.Id -Timeout $StartupTimeoutSeconds `
        -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
  }
}
