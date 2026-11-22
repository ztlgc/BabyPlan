Set-StrictMode -Version Latest

function Read-BabyPlanEnvFile {
  param(
    [Parameter(Mandatory)]
    [string]$Path
  )

  $resolved = [System.IO.Path]::GetFullPath($Path)
  if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) {
    throw "环境文件不存在：$resolved"
  }

  $values = @{}
  $lineNumber = 0
  foreach ($line in Get-Content -LiteralPath $resolved -Encoding UTF8) {
    $lineNumber++
    $trimmed = $line.Trim()
    if ($trimmed.Length -eq 0 -or $trimmed.StartsWith('#')) {
      continue
    }
    $separator = $trimmed.IndexOf('=')
    if ($separator -lt 1) {
      throw "环境文件第 $lineNumber 行格式无效。"
    }
    $name = $trimmed.Substring(0, $separator).Trim()
    $value = $trimmed.Substring($separator + 1).Trim()
    if ($name -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') {
      throw "环境文件第 $lineNumber 行变量名无效。"
    }
    if ($values.ContainsKey($name)) {
      throw "环境文件包含重复变量：$name"
    }
    if (
      $value.Length -ge 2 -and
      (($value.StartsWith('"') -and $value.EndsWith('"')) -or
        ($value.StartsWith("'") -and $value.EndsWith("'")))
    ) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    $values[$name] = $value
  }
  return $values
}

function Import-BabyPlanEnvironment {
  param(
    [Parameter(Mandatory)]
    [hashtable]$Values
  )

  $original = @{}
  foreach ($entry in $Values.GetEnumerator()) {
    $original[$entry.Key] = [Environment]::GetEnvironmentVariable(
      $entry.Key,
      'Process'
    )
    [Environment]::SetEnvironmentVariable(
      $entry.Key,
      [string]$entry.Value,
      'Process'
    )
  }
  return $original
}

function Restore-BabyPlanEnvironment {
  param(
    [Parameter(Mandatory)]
    [hashtable]$Original
  )

  foreach ($entry in $Original.GetEnumerator()) {
    if ($null -eq $entry.Value) {
      # PowerShell 会把 null 绑定成空字符串；显式删除才能真正恢复“原本不存在”。
      Remove-Item "Env:$($entry.Key)" -ErrorAction SilentlyContinue
    } else {
      [Environment]::SetEnvironmentVariable(
        $entry.Key,
        [string]$entry.Value,
        'Process'
      )
    }
  }
}

function Set-PostgresConnectionEnvironment {
  param(
    [Parameter(Mandatory)]
    [string]$DatabaseUrl
  )

  $uri = $null
  if (-not [Uri]::TryCreate($DatabaseUrl, [UriKind]::Absolute, [ref]$uri)) {
    throw 'DATABASE_URL 格式无效。'
  }
  if ($uri.Scheme -notin @('postgres', 'postgresql')) {
    throw 'DATABASE_URL 必须使用 postgres 或 postgresql 协议。'
  }
  if (-not $uri.Host -or -not $uri.UserInfo) {
    throw 'DATABASE_URL 缺少主机或凭证。'
  }
  $userParts = $uri.UserInfo.Split(':', 2)
  if ($userParts.Count -ne 2 -or -not $userParts[0]) {
    throw 'DATABASE_URL 缺少用户名或口令。'
  }
  $database = [Uri]::UnescapeDataString(
    $uri.AbsolutePath.TrimStart('/')
  )
  if (-not $database) {
    throw 'DATABASE_URL 缺少数据库名。'
  }

  $original = @{}
  $connection = [ordered]@{
    PGHOST = $uri.Host
    PGPORT = if ($uri.IsDefaultPort) { '5432' } else { [string]$uri.Port }
    PGUSER = [Uri]::UnescapeDataString($userParts[0])
    PGPASSWORD = [Uri]::UnescapeDataString($userParts[1])
    PGDATABASE = $database
  }
  foreach ($queryPart in $uri.Query.TrimStart('?').Split('&')) {
    if (-not $queryPart) { continue }
    $pair = $queryPart.Split('=', 2)
    $key = [Uri]::UnescapeDataString($pair[0])
    $value = if ($pair.Count -eq 2) {
      [Uri]::UnescapeDataString($pair[1])
    } else {
      ''
    }
    if ($key -eq 'sslmode') {
      if ($value -notin @('disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full')) {
        throw 'DATABASE_URL 中的 sslmode 无效。'
      }
      $connection.PGSSLMODE = $value
    } elseif ($key -eq 'application_name') {
      # 应用名不参与备份恢复，忽略该查询参数。
    } else {
      throw "DATABASE_URL 含不受支持的查询参数：$key"
    }
  }

  foreach ($entry in $connection.GetEnumerator()) {
    $original[$entry.Key] = [Environment]::GetEnvironmentVariable(
      $entry.Key,
      'Process'
    )
    [Environment]::SetEnvironmentVariable(
      $entry.Key,
      [string]$entry.Value,
      'Process'
    )
  }
  return $original
}

function Resolve-PostgresTool {
  param(
    [Parameter(Mandatory)]
    [string]$Name
  )

  $command = Get-Command "$Name.exe" -CommandType Application -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($command) {
    return $command.Source
  }
  $installRoot = Join-Path $env:ProgramFiles 'PostgreSQL'
  if (Test-Path -LiteralPath $installRoot -PathType Container) {
    $candidate = Get-ChildItem -LiteralPath $installRoot -Directory |
      Sort-Object {
        $parsed = [version]'0.0'
        [void][version]::TryParse($_.Name, [ref]$parsed)
        $parsed
      } -Descending |
      ForEach-Object {
        Join-Path $_.FullName "bin\$Name.exe"
      } |
      Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
      Select-Object -First 1
    if ($candidate) { return $candidate }
  }
  throw "找不到 PostgreSQL 工具 $Name.exe。"
}

function Invoke-CheckedProcess {
  param(
    [Parameter(Mandatory)]
    [string]$FilePath,
    [string[]]$ArgumentList = @(),
    [string]$FailureMessage = '命令执行失败',
    [switch]$SuppressOutput
  )

  if ($SuppressOutput) {
    & $FilePath @ArgumentList | Out-Null
  } else {
    & $FilePath @ArgumentList
  }
  if ($LASTEXITCODE -ne 0) {
    throw "$FailureMessage（退出码 $LASTEXITCODE）"
  }
}

function Get-NormalizedFullPath {
  param(
    [Parameter(Mandatory)]
    [string]$Path,
    [string]$BasePath = (Get-Location).Path
  )

  if ([System.IO.Path]::IsPathRooted($Path)) {
    return [System.IO.Path]::GetFullPath($Path)
  }
  return [System.IO.Path]::GetFullPath((Join-Path $BasePath $Path))
}

function Assert-PathInside {
  param(
    [Parameter(Mandatory)]
    [string]$Path,
    [Parameter(Mandatory)]
    [string]$Parent
  )

  $resolvedPath = [System.IO.Path]::GetFullPath($Path)
  $resolvedParent = [System.IO.Path]::GetFullPath($Parent).TrimEnd(
    [System.IO.Path]::DirectorySeparatorChar,
    [System.IO.Path]::AltDirectorySeparatorChar
  )
  $prefix = $resolvedParent + [System.IO.Path]::DirectorySeparatorChar
  if (
    -not $resolvedPath.Equals(
      $resolvedParent,
      [StringComparison]::OrdinalIgnoreCase
    ) -and
    -not $resolvedPath.StartsWith(
      $prefix,
      [StringComparison]::OrdinalIgnoreCase
    )
  ) {
    throw "路径不在允许目录内：$resolvedPath"
  }
  return $resolvedPath
}

function Test-PathTreesOverlap {
  param(
    [Parameter(Mandatory)]
    [string]$Path,
    [Parameter(Mandatory)]
    [string]$OtherPath
  )

  $resolvedPath = [System.IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
  $resolvedOther = [System.IO.Path]::GetFullPath($OtherPath).TrimEnd('\', '/')
  $separator = [System.IO.Path]::DirectorySeparatorChar
  return (
    $resolvedPath.Equals(
      $resolvedOther,
      [StringComparison]::OrdinalIgnoreCase
    ) -or
    $resolvedPath.StartsWith(
      "$resolvedOther$separator",
      [StringComparison]::OrdinalIgnoreCase
    ) -or
    $resolvedOther.StartsWith(
      "$resolvedPath$separator",
      [StringComparison]::OrdinalIgnoreCase
    )
  )
}

function Protect-BabyPlanSecretFile {
  param(
    [Parameter(Mandatory)]
    [string]$Path
  )

  if (-not $IsWindows) { return }
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  $security = New-Object System.Security.AccessControl.FileSecurity
  $security.SetAccessRuleProtection($true, $false)
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
    $identity,
    [System.Security.AccessControl.FileSystemRights]'Read,Write',
    [System.Security.AccessControl.AccessControlType]::Allow
  )
  $security.AddAccessRule($rule)
  try {
    Set-Acl -LiteralPath $Path -AclObject $security
  } catch {
    Write-Warning '无法进一步收紧文件 ACL；请确认父目录仅授权给部署账户。'
  }
}

function Protect-BabyPlanSecretDirectory {
  param(
    [Parameter(Mandatory)]
    [string]$Path
  )

  if (-not $IsWindows) { return }
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  $security = New-Object System.Security.AccessControl.DirectorySecurity
  $security.SetAccessRuleProtection($true, $false)
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
    $identity,
    [System.Security.AccessControl.FileSystemRights]'FullControl',
    [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',
    [System.Security.AccessControl.PropagationFlags]::None,
    [System.Security.AccessControl.AccessControlType]::Allow
  )
  $security.AddAccessRule($rule)
  try {
    Set-Acl -LiteralPath $Path -AclObject $security
  } catch {
    Write-Warning '无法进一步收紧目录 ACL；请确认父目录仅授权给部署账户。'
  }
}

function Invoke-BabyPlanDeletionJournal {
  param(
    [Parameter(Mandatory)]
    [hashtable]$Values,
    [Parameter(Mandatory)]
    [ValidateSet('prepare-backup', 'replay-restore')]
    [string]$Action,
    [string]$JournalId
  )

  $repositoryRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
  $apiRoot = Join-Path $repositoryRoot 'services/api'
  $entry = Join-Path $apiRoot 'dist/cli/deletions.js'
  if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) {
    throw '缺少删除台账工具。请先在 services/api 运行 npm run build。'
  }
  $node = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source
  $connection = Set-PostgresConnectionEnvironment -DatabaseUrl $Values.DATABASE_URL
  $original = @{}
  Push-Location $apiRoot
  try {
    # 不继承另一套环境的台账路径。
    $settings = $Values.Clone()
    if (-not $settings.ContainsKey('DELETION_JOURNAL_ROOT')) {
      $settings.DELETION_JOURNAL_ROOT = Join-Path (Split-Path -Parent $settings.RECOVERY_OUTBOX_ROOT) 'deletion-journal'
    }
    $original = Import-BabyPlanEnvironment -Values $settings
    $arguments = @($entry, $Action)
    if ($JournalId) { $arguments += $JournalId }
    $output = & $node @arguments
    if ($LASTEXITCODE -ne 0) {
      throw '删除台账未能核对或重放。备份与恢复需要同一部署的最新独立台账。'
    }
    return ($output | ConvertFrom-Json -ErrorAction Stop)
  } finally {
    Pop-Location
    Restore-BabyPlanEnvironment -Original $original
    Restore-BabyPlanEnvironment -Original $connection
  }
}

function Get-TreeDigest {
  param(
    [Parameter(Mandatory)]
    [string]$Path
  )

  if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
    return [ordered]@{
      exists = $false
      fileCount = 0
      byteCount = 0
      digestSha256 = $null
    }
  }
  $rootItem = Get-Item -LiteralPath $Path -Force
  if (
    ($rootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
  ) {
    throw "媒体目录本身不能是符号链接：$Path"
  }
  # 目录型链接可能未被 -File 枚举覆盖；先单独拒绝，避免备份静默漏项。
  foreach ($directory in Get-ChildItem -LiteralPath $Path -Directory -Recurse -Force) {
    if (
      ($directory.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
    ) {
      throw "媒体目录中包含不允许备份的符号链接目录：$($directory.FullName)"
    }
  }
  $records = [System.Collections.Generic.List[string]]::new()
  $fileCount = 0
  [long]$byteCount = 0
  foreach ($file in Get-ChildItem -LiteralPath $Path -File -Recurse -Force) {
    if (($file.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "媒体目录中包含不允许备份的符号链接：$($file.FullName)"
    }
    $relative = [System.IO.Path]::GetRelativePath($Path, $file.FullName)
    $normalized = $relative.Replace('\', '/')
    $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
    $records.Add("$normalized`t$($file.Length)`t$hash")
    $fileCount++
    $byteCount += $file.Length
  }
  $records.Sort([StringComparer]::Ordinal)
  $bytes = [Text.Encoding]::UTF8.GetBytes(($records -join "`n"))
  $digest = [Convert]::ToHexString(
    [Security.Cryptography.SHA256]::HashData($bytes)
  )
  return [ordered]@{
    exists = $true
    fileCount = $fileCount
    byteCount = $byteCount
    digestSha256 = $digest
  }
}

function Test-BabyPlanApiOnline {
  param(
    [string]$HostName = '127.0.0.1',
    [int]$Port = 4318
  )

  $probeHost = Get-BabyPlanProbeHost -HostName $HostName
  $client = [System.Net.Sockets.TcpClient]::new()
  try {
    $task = $client.ConnectAsync($probeHost, $Port)
    if (-not $task.Wait(800)) { return $false }
    return $client.Connected
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

function Get-BabyPlanProbeHost {
  param(
    [string]$HostName = '127.0.0.1'
  )

  if ($HostName -in @('0.0.0.0', '::', '[::]')) {
    return '127.0.0.1'
  }
  return $HostName
}

Export-ModuleMember -Function @(
  'Read-BabyPlanEnvFile',
  'Import-BabyPlanEnvironment',
  'Restore-BabyPlanEnvironment',
  'Set-PostgresConnectionEnvironment',
  'Resolve-PostgresTool',
  'Invoke-CheckedProcess',
  'Get-NormalizedFullPath',
  'Assert-PathInside',
  'Test-PathTreesOverlap',
  'Protect-BabyPlanSecretFile',
  'Protect-BabyPlanSecretDirectory',
  'Get-TreeDigest',
  'Invoke-BabyPlanDeletionJournal',
  'Get-BabyPlanProbeHost',
  'Test-BabyPlanApiOnline'
)
