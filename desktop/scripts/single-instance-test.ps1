<#
  单实例锁验证：同一数据目录下启动第二个实例时，它必须立刻退出，
  否则两个进程会同时写同一个 SQLite 文件。
#>
param(
  [string]$Exe = 'D:\HomeChef\desktop\release\win-unpacked\HomeChef.exe',
  [string]$Root = (Join-Path $env:TEMP ('hc-single-' + [guid]::NewGuid().ToString('N').Substring(0, 8)))
)
$ErrorActionPreference = 'Stop'
$dataRoot = Join-Path $Root 'HomeChef'
New-Item -ItemType Directory -Path $dataRoot -Force | Out-Null
$logPath = Join-Path $dataRoot 'logs\main.log'
$steps = @()

function Start-App {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $Exe; $psi.Arguments = ''; $psi.UseShellExecute = $false
  $psi.EnvironmentVariables['HOME_CHEF_DATA_DIR'] = $dataRoot
  $psi.EnvironmentVariables.Remove('ELECTRON_RUN_AS_NODE')
  $psi.WorkingDirectory = Split-Path $Exe
  [System.Diagnostics.Process]::Start($psi)
}
function Add-Step([string]$n, [bool]$ok, [string]$d) {
  $script:steps += [ordered]@{ name = $n; ok = $ok; detail = $d }
  Write-Host ('[{0}] {1} :: {2}' -f ($(if ($ok) { 'PASS' } else { 'FAIL' })), $n, $d)
}

$first = Start-App
$port = 0
for ($i = 0; $i -lt 200; $i++) {
  Start-Sleep -Milliseconds 300
  if (Test-Path $logPath) {
    $m = [regex]::Match((Get-Content $logPath -Raw), 'http://127\.0\.0\.1:(\d+)')
    if ($m.Success) { $port = [int]$m.Groups[1].Value; break }
  }
}
Add-Step '第一个实例启动' ($port -gt 0) ('port=' + $port)

$sw = [System.Diagnostics.Stopwatch]::StartNew()
$second = Start-App
$secondExited = $second.WaitForExit(30000)
$sw.Stop()
Add-Step '第二个实例立即退出' ($secondExited) ('exited=' + $secondExited + ' 用时=' + [math]::Round($sw.Elapsed.TotalSeconds,1) + 's')
if (-not $secondExited) { Stop-Process -Id $second.Id -Force -ErrorAction SilentlyContinue }

$still = Invoke-WebRequest -Uri ('http://127.0.0.1:' + $port + '/health') -UseBasicParsing -TimeoutSec 10
Add-Step '第一个实例仍在服务' ($still.StatusCode -eq 200) ('status=' + $still.StatusCode)

$first.CloseMainWindow() | Out-Null
if (-not $first.WaitForExit(20000)) { Stop-Process -Id $first.Id -Force }
Add-Step '第一个实例可正常退出' ($first.HasExited) 'closed'

[ordered]@{
  root = $Root
  steps = $steps
  summary = [ordered]@{ passed = @($steps | Where-Object { $_.ok }).Count; failed = @($steps | Where-Object { -not $_.ok }).Count }
} | ConvertTo-Json -Depth 5
