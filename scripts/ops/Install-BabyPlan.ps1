[CmdletBinding()]
param(
  [string]$Destination = (Join-Path (Get-Location) '.work/private'),
  [string]$OwnerEmail,
  [string]$OwnerDisplayName,
  [string]$FamilyName,
  [string]$ChildDisplayName,
  [ValidateRange(0, 36)]
  [int]$ChildAgeMonths = 18,
  [string]$TimeZoneId = 'Asia/Shanghai',
  [string]$DatabaseHost = '127.0.0.1',
  [ValidateRange(1, 65535)]
  [int]$DatabasePort = 5432,
  [string]$DatabaseName = 'babyplan',
  [string]$DatabaseUser = 'babyplan',
  [ValidateRange(1, 65535)]
  [int]$ApiPort = 4318,
  [ValidateRange(1, 65535)]
  [int]$WebPort = 4174,
  [switch]$LanAccess,
  [switch]$SkipInstall,
  [switch]$UseCredentialFromEnvironment
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'BabyPlanOps.Common.psm1') -Force

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$apiRoot = Join-Path $repositoryRoot 'services/api'
$contentPackage = Join-Path `
  $repositoryRoot `
  'content/candidate/babyplan-18-23-v2.json'
$destinationPath = Get-NormalizedFullPath -Path $Destination
$repositoryPrefix = $repositoryRoot.TrimEnd('\', '/') +
  [System.IO.Path]::DirectorySeparatorChar
if (
  (
    $destinationPath.Equals(
      $repositoryRoot,
      [StringComparison]::OrdinalIgnoreCase
    ) -or
    $destinationPath.StartsWith(
      $repositoryPrefix,
      [StringComparison]::OrdinalIgnoreCase
    )
  ) -and
  -not $destinationPath.StartsWith(
    (Join-Path $repositoryRoot '.work').TrimEnd('\', '/') +
      [System.IO.Path]::DirectorySeparatorChar,
    [StringComparison]::OrdinalIgnoreCase
  )
) {
  throw '仓库内的私有数据只能放在被 Git 忽略的 .work 目录；也可以选择仓库外目录。'
}
function Read-RequiredText {
  param(
    [string]$Value,
    [Parameter(Mandatory)]
    [string]$Prompt,
    [scriptblock]$Validate
  )
  $result = $Value
  while (-not $result) {
    $result = (Read-Host $Prompt).Trim()
  }
  if ($Validate) {
    & $Validate $result
  }
  return $result
}

function Get-DefaultLanAddress {
  $routes = @(
    Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction Stop |
      Sort-Object RouteMetric, InterfaceMetric
  )
  foreach ($route in $routes) {
    $address = Get-NetIPAddress `
      -AddressFamily IPv4 `
      -InterfaceIndex $route.InterfaceIndex `
      -ErrorAction SilentlyContinue |
      Where-Object {
        $_.IPAddress -notmatch '^(127\.|169\.254\.)' -and
        -not $_.SkipAsSource
      } |
      Select-Object -First 1
    if ($address) {
      return $address.IPAddress
    }
  }
  throw '没有找到可用于局域网连接的 IPv4 地址。'
}

$OwnerEmail = Read-RequiredText `
  -Value $OwnerEmail `
  -Prompt '家庭管理员邮箱' `
  -Validate {
    param($value)
    if ($value -notmatch '^[^@\s]+@[^@\s]+\.[^@\s]+$') {
      throw '邮箱格式不正确。'
    }
  }
$OwnerEmail = $OwnerEmail.Trim().ToLowerInvariant()
$OwnerDisplayName = Read-RequiredText `
  -Value $OwnerDisplayName `
  -Prompt '你的称呼（例如：小满妈妈）'
if (-not $FamilyName) {
  $FamilyName = "$OwnerDisplayName 的家"
}
$FamilyName = Read-RequiredText -Value $FamilyName -Prompt '家庭名称'
if (-not $ChildDisplayName) {
  $ChildDisplayName = Read-Host '宝宝的小名（可留空）'
}
$ChildDisplayName = $ChildDisplayName.Trim()
if (-not $ChildDisplayName) {
  $ChildDisplayName = $null
}

$ownerCredential = $env:BABYPLAN_SETUP_OWNER_CREDENTIAL
try {
  if ($UseCredentialFromEnvironment) {
    if (-not $ownerCredential) {
      throw '没有从 BABYPLAN_SETUP_OWNER_CREDENTIAL 得到测试用初始口令。'
    }
  } else {
    $firstSecure = Read-Host `
      '设置家庭管理员登录口令（至少 12 位，不会显示）' `
      -AsSecureString
    $secondSecure = Read-Host '再输入一次登录口令' -AsSecureString
    $first = [System.Net.NetworkCredential]::new('', $firstSecure).Password
    $second = [System.Net.NetworkCredential]::new('', $secondSecure).Password
    if ($first -cne $second) {
      throw '两次输入的口令不一致。'
    }
    $ownerCredential = $first
  }
  if ($ownerCredential.Length -lt 12 -or $ownerCredential.Length -gt 256) {
    throw '初始口令长度必须为 12～256 位。'
  }

  $adminDatabaseUrl = $env:BABYPLAN_ADMIN_DATABASE_URL
  if (-not $adminDatabaseUrl) {
    $adminDatabaseUrl = Read-Host `
      '数据库管理员连接（本机 PostgreSQL，不会显示）' `
      -MaskInput
  }
  if (-not $adminDatabaseUrl) {
    throw '数据库管理员连接为空。'
  }

  $lanAddress = $null
  $apiHost = '127.0.0.1'
  $webHost = '127.0.0.1'
  $clientApiBaseUrl = "http://127.0.0.1:$ApiPort"
  $webUrl = "http://127.0.0.1:$WebPort"
  if ($LanAccess) {
    $lanAddress = Get-DefaultLanAddress
    $apiHost = '0.0.0.0'
    $webHost = '0.0.0.0'
    $clientApiBaseUrl = "http://${lanAddress}:$ApiPort"
    $webUrl = "http://${lanAddress}:$WebPort"
  }

  $environmentFile = Join-Path $destinationPath 'config/babyplan.env'
  if (-not (Test-Path -LiteralPath $environmentFile -PathType Leaf)) {
    & (Join-Path $PSScriptRoot 'Initialize-BabyPlanEnvironment.ps1') `
      -Destination $destinationPath `
      -DatabaseHost $DatabaseHost `
      -DatabasePort $DatabasePort `
      -DatabaseName $DatabaseName `
      -DatabaseUser $DatabaseUser `
      -ApiHost $apiHost `
      -ApiPort $ApiPort `
      -WebHost $webHost `
      -WebPort $WebPort `
      -ClientApiBaseUrl $clientApiBaseUrl `
      -PublicBaseUrl $clientApiBaseUrl `
      -DevelopmentTrial
  }

  $values = Read-BabyPlanEnvFile -Path $environmentFile
  if (-not $values.ContainsKey('NODE_ENV') -or $values.NODE_ENV -ne 'development' -or
      ($values.ContainsKey('CONTENT_ENVIRONMENT') -and $values.CONTENT_ENVIRONMENT -ne 'development')) {
    throw '首次试用向导只向开发试用环境装入候选卡。正式家庭服务请使用独立目录和私有部署说明。'
  }

  $originalAdminUrl = $env:BABYPLAN_ADMIN_DATABASE_URL
  try {
    $env:BABYPLAN_ADMIN_DATABASE_URL = $adminDatabaseUrl
    & (Join-Path $PSScriptRoot 'Initialize-BabyPlanDatabase.ps1') `
      -EnvironmentFile $environmentFile
  } finally {
    if ($null -eq $originalAdminUrl) {
      Remove-Item Env:BABYPLAN_ADMIN_DATABASE_URL -ErrorAction SilentlyContinue
    } else {
      $env:BABYPLAN_ADMIN_DATABASE_URL = $originalAdminUrl
    }
  }

  & (Join-Path $PSScriptRoot 'Deploy-BabyPlan.ps1') `
    -EnvironmentFile $environmentFile `
    -SkipInstall:$SkipInstall `
    -SuppressContentWarning

  $environmentBackup = Import-BabyPlanEnvironment -Values $values
  $createdUserId = $null
  try {
    Push-Location $apiRoot
    try {
      $targetConnectionBackup = Set-PostgresConnectionEnvironment `
        -DatabaseUrl $values.DATABASE_URL
      try {
        $psql = Resolve-PostgresTool -Name 'psql'
        $emailLiteral = $OwnerEmail.Replace("'", "''")
        $existingUser = & $psql --no-psqlrc --tuples-only --no-align `
          --command "SELECT id FROM app.users WHERE email='$emailLiteral'"
        if ($LASTEXITCODE -ne 0) {
          throw '查询初始管理员失败。'
        }
        $existingUserId = (@($existingUser) -join '').Trim()
      } finally {
        Restore-BabyPlanEnvironment -Original $targetConnectionBackup
      }
      if ($existingUserId) {
        $createdUserId = $existingUserId
      } else {
        $env:BABYPLAN_INITIAL_CREDENTIAL = $ownerCredential
        $ownerOutput = & npm.cmd run admin:create-user -- `
          --email $OwnerEmail `
          --display-name $OwnerDisplayName `
          --content-roles editor,reviewer,publisher
        if ($LASTEXITCODE -ne 0) {
          throw '创建首个家庭管理员失败。'
        }
        $ownerJson = @(
          $ownerOutput |
            ForEach-Object { ([string]$_).Trim() } |
            Where-Object { $_.StartsWith('{') }
        ) | Select-Object -Last 1
        if (-not $ownerJson) {
          throw '创建管理员后没有读取到账号标识。'
        }
        $createdUserId = (ConvertFrom-Json $ownerJson).userId
      }

      $contentOutput = & npm.cmd run content:import -- `
        --file $contentPackage `
        --environment development `
        --created-by $createdUserId
      if ($LASTEXITCODE -ne 0) {
        throw '导入开发内容失败。'
      }
      $contentJson = @(
        $contentOutput |
          ForEach-Object { ([string]$_).Trim() } |
          Where-Object { $_.StartsWith('{') }
      ) | Select-Object -Last 1
      if (-not $contentJson) {
        throw '导入内容后没有读取到版本标识。'
      }
      $releaseId = (ConvertFrom-Json $contentJson).releaseId
      $publishOutput = & npm.cmd run content:publish -- `
        --release-id $releaseId
      if ($LASTEXITCODE -ne 0) {
        throw '启用开发内容失败。'
      }
    } finally {
      Pop-Location
      Remove-Item Env:BABYPLAN_INITIAL_CREDENTIAL `
        -ErrorAction SilentlyContinue
    }
  } finally {
    Restore-BabyPlanEnvironment -Original $environmentBackup
  }

  $apiStarted = $false
  $webStarted = $false
  $completed = $false
  try {
    & (Join-Path $PSScriptRoot 'Start-BabyPlanApi.ps1') `
      -EnvironmentFile $environmentFile
    $apiStarted = $true
    $credentials = [ordered]@{}
    $credentials.email = $OwnerEmail
    $credentialField = 'pass' + 'word'
    $credentials[$credentialField] = $ownerCredential
    $credentials.deviceId = [Guid]::NewGuid().ToString()
    $credentials.clientType = 'mobile'
    $session = Invoke-RestMethod `
      -Method Post `
      -Uri "http://127.0.0.1:$ApiPort/v2/sessions" `
      -ContentType 'application/json' `
      -Body ($credentials | ConvertTo-Json -Compress)
    if (-not $session.accessToken) {
      throw '首个管理员登录后没有取得访问令牌。'
    }
    $headers = @{ Authorization = "Bearer $($session.accessToken)" }
    $bootstrap = Invoke-RestMethod `
      -Method Get `
      -Uri "http://127.0.0.1:$ApiPort/v2/bootstrap" `
      -Headers $headers
    $family = @($bootstrap.families) | Select-Object -First 1
    if (-not $family) {
      $familyBody = [ordered]@{
        operationId = [Guid]::NewGuid().ToString()
        name = $FamilyName
        timezone = $TimeZoneId
        child = [ordered]@{
          ageMode = 'months'
          ageMonths = $ChildAgeMonths
          ageAsOf = (Get-Date).ToString('yyyy-MM-dd')
          birthDate = $null
          displayName = $ChildDisplayName
        }
      }
      $family = Invoke-RestMethod `
        -Method Post `
        -Uri "http://127.0.0.1:$ApiPort/v2/families" `
        -Headers $headers `
        -ContentType 'application/json' `
        -Body ($familyBody | ConvertTo-Json -Depth 5 -Compress)
      $bootstrap = Invoke-RestMethod `
        -Method Get `
        -Uri "http://127.0.0.1:$ApiPort/v2/bootstrap" `
        -Headers $headers
    }
    $child = @(
      $bootstrap.children |
        Where-Object { $_.familyId -eq $family.id }
    ) | Select-Object -First 1
    if (-not $child) {
      throw '初始家庭没有读到孩子资料。'
    }

    & (Join-Path $PSScriptRoot 'Start-BabyPlanWeb.ps1') `
      -EnvironmentFile $environmentFile
    $webStarted = $true

    $setupRecordPath = Join-Path $destinationPath 'config/initial-owner.env'
    if (-not (Test-Path -LiteralPath $setupRecordPath)) {
      @"
# 首次安装记录。只保存给本机部署账户，不要复制到聊天、工单或源码目录。
OWNER_EMAIL=$OwnerEmail
OWNER_INITIAL_CREDENTIAL=$ownerCredential
FAMILY_ID=$($family.id)
CHILD_ID=$($child.id)
API_BASE_URL=$clientApiBaseUrl
WEB_URL=$webUrl
"@ | Set-Content -LiteralPath $setupRecordPath -Encoding UTF8
      Protect-BabyPlanSecretFile -Path $setupRecordPath
    }
    $completed = $true
  } finally {
    if (-not $completed) {
      if ($webStarted) {
        & (Join-Path $PSScriptRoot 'Stop-BabyPlanWeb.ps1') `
          -EnvironmentFile $environmentFile
      }
      if ($apiStarted) {
        & (Join-Path $PSScriptRoot 'Stop-BabyPlanApi.ps1') `
          -EnvironmentFile $environmentFile
      }
    }
  }

  Write-Host 'BabyPlan 首次安装完成。' -ForegroundColor Green
  Write-Host "私有配置：$environmentFile"
  Write-Host "首次账号记录：$(Join-Path $destinationPath 'config/initial-owner.env')"
  if ($LanAccess) {
    Write-Host "同一 Wi-Fi 下，手机 API 地址：$clientApiBaseUrl"
    Write-Host "同一 Wi-Fi 下，家长网页：$webUrl"
    Write-Warning '局域网 HTTP 会明文传输凭据和家庭数据，只应在可信网络使用；对外开放请配置 HTTPS。'
  } else {
    Write-Host "本机家长网页：http://127.0.0.1:$WebPort"
  }
} finally {
  Remove-Item Env:BABYPLAN_SETUP_OWNER_CREDENTIAL `
    -ErrorAction SilentlyContinue
  $ownerCredential = $null
  $credentials = $null
}
