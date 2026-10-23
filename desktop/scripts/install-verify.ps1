<#
  安装包端到端验证（安装 → 升级 → 启动 → 卸载 → 清理）。

  全部使用临时目录：安装目录与数据目录都在 %TEMP% 下，
  不写 %LOCALAPPDATA%\Programs，也不碰真实 %APPDATA%\HomeChef。
  无论成功失败，finally 都会卸载并删除自己创建的目录。
#>
param(
  [string]$Installer = 'D:\HomeChef\desktop\release\HomeChef-Setup-0.2.5.exe',
  [string]$Base = (Join-Path $env:TEMP ('hc-inst-' + [guid]::NewGuid().ToString('N').Substring(0, 8)))
)
$ErrorActionPreference = 'Stop'
# Lumi: verify test-owned path before allowing recursive cleanup.
$resolvedBase = [IO.Path]::GetFullPath($Base).TrimEnd('\')
$resolvedTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
if ((Split-Path $resolvedBase -Parent) -ine $resolvedTemp -or (Split-Path $resolvedBase -Leaf) -notmatch '^hc-inst-[0-9a-f]{8}$' -or (Test-Path -LiteralPath $resolvedBase)) {
  throw 'Install verification requires a new, uniquely named hc-inst-XXXXXXXX directory directly inside TEMP.'
}
$Base = $resolvedBase
$installDir = Join-Path $Base 'install'
$dataRoot = Join-Path $Base 'data'
New-Item -ItemType Directory -Path $Base -Force | Out-Null
$steps = @()
function Add-Step([string]$n, [bool]$ok, [string]$d) {
  $script:steps += [ordered]@{ name = $n; ok = $ok; detail = $d }
  Write-Host ('[{0}] {1} :: {2}' -f ($(if ($ok) { 'PASS' } else { 'FAIL' })), $n, $d)
}
function Remove-TempBase([string]$path) {
  # 只清理本测试自己创建的临时目录。
  # 校验：① 必须在 %TEMP% 之下 ② 目录名必须是本测试的前缀 ③ 不能是 TEMP 本身。
  # 绝不清理默认用户数据目录（%APPDATA%\HomeChef 等）。
  try {
    $resolved = [System.IO.Path]::GetFullPath($path).TrimEnd('\')
    $tempRoot = [System.IO.Path]::GetFullPath($env:TEMP).TrimEnd('\')
    if ($resolved -eq $tempRoot) {
      Write-Host '[WARN] 拒绝清理：Base 指向临时目录本身'
      return
    }
    if (-not $resolved.StartsWith($tempRoot + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
      Write-Host ('[WARN] 拒绝清理：Base 不在临时目录下 -> ' + $resolved)
      return
    }
    if ((Split-Path $resolved -Leaf) -notmatch '^(hc-|homechef-)') {
      Write-Host ('[WARN] 拒绝清理：目录名不是本测试创建的 -> ' + $resolved)
      return
    }
    if (Test-Path -LiteralPath $resolved) {
      Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction Stop
      Write-Host ('cleaned ' + $resolved)
    }
  } catch {
    Write-Host ('[WARN] 清理失败：' + $_.Exception.Message)
  }
}

function Get-Origin([string]$logPath, [int]$timeoutSeconds) {
  $deadline = (Get-Date).AddSeconds($timeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 400
    if (Test-Path $logPath) {
      $m = [regex]::Match((Get-Content $logPath -Raw), 'http://127\.0\.0\.1:(\d+)')
      if ($m.Success) { return [int]$m.Groups[1].Value }
    }
  }
  throw '等待服务启动超时'
}
function Stop-App($proc) {
  for ($i = 0; $i -lt 6; $i++) {
    if ($proc.HasExited) { return $true }
    $proc.CloseMainWindow() | Out-Null
    if ($proc.WaitForExit(2000)) { return $true }
    & taskkill /PID $proc.Id 2>&1 | Out-Null
    if ($proc.WaitForExit(3000)) { return $true }
  }
  Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
  return $false
}
function Start-App([string]$exe) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $exe; $psi.Arguments = ''; $psi.UseShellExecute = $false
  $psi.EnvironmentVariables['HOME_CHEF_DATA_DIR'] = (Join-Path $dataRoot 'HomeChef')
  $psi.EnvironmentVariables.Remove('ELECTRON_RUN_AS_NODE')
  $psi.WorkingDirectory = Split-Path $exe
  [System.Diagnostics.Process]::Start($psi)
}
function Invoke-Installer([string]$target) {
  # NSIS: /D 必须是最后一个参数且不加引号
  $p = Start-Process -FilePath $Installer -ArgumentList '/S', ('/D=' + $target) -Wait -PassThru
  return $p.ExitCode
}
function Uninstall-App([string]$dir) {
  $un = Join-Path $dir 'Uninstall HomeChef.exe'
  if (-not (Test-Path $un)) { return $false }
  Start-Process -FilePath $un -ArgumentList '/S' | Out-Null
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 500
    if (-not (Test-Path $dir)) { return $true }
  }
  return (-not (Test-Path $dir))
}

$logPath = Join-Path $dataRoot 'HomeChef\logs\main.log'
$proc = $null
try {
  $code = Invoke-Installer $installDir
  Add-Step '静默安装退出码 0' ($code -eq 0) ('exit=' + $code)
  Add-Step '安装目录内容完整' (
    (Test-Path (Join-Path $installDir 'HomeChef.exe')) -and
    (Test-Path (Join-Path $installDir 'resources\app.asar')) -and
    (Test-Path (Join-Path $installDir 'resources\web\index.html')) -and
    (Test-Path (Join-Path $installDir 'resources\drizzle\meta\_journal.json'))
  ) $installDir
  Add-Step '未污染默认安装位置' (-not (Test-Path (Join-Path $env:LOCALAPPDATA 'Programs\HomeChef'))) 'localappdata clean'

  $proc = Start-App (Join-Path $installDir 'HomeChef.exe')
  $port = Get-Origin $logPath 90
  Add-Step '安装版可启动' ($port -gt 0) ('port=' + $port)
  $health = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $port + '/health') -TimeoutSec 10
  Add-Step '健康检查' ($health.status -eq 'ok') ([string]$health.status)
  $body = @{ name = '安装验证食材'; units = @('个') } | ConvertTo-Json -Compress
  $created = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $port + '/api/definitions') -Method Post -Body $body -ContentType 'application/json; charset=utf-8' -TimeoutSec 10
  Add-Step '写入数据' ($null -ne $created.id) ('id=' + [string]$created.id)
  Add-Step '优雅关闭' ((Stop-App $proc) -eq $true) 'graceful'

  # 升级：覆盖安装同一目录
  $code2 = Invoke-Installer $installDir
  Add-Step '覆盖安装退出码 0' ($code2 -eq 0) ('exit=' + $code2)
  Move-Item -Path $logPath -Destination ($logPath + '.first') -Force
  $proc = Start-App (Join-Path $installDir 'HomeChef.exe')
  $port2 = Get-Origin $logPath 90
  $defs = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $port2 + '/api/definitions') -TimeoutSec 15
  $found = @($defs) | Where-Object { $_.name -eq '安装验证食材' }
  Add-Step '升级后数据仍在' ($null -ne $found) ('found=' + [bool]($null -ne $found))
  Add-Step '升级后优雅关闭' ((Stop-App $proc) -eq $true) 'graceful'
  $proc = $null

  Add-Step '卸载完成' (Uninstall-App $installDir) 'dir removed'
  Add-Step '卸载后无残留进程' (@(Get-Process -Name 'HomeChef' -ErrorAction SilentlyContinue).Count -eq 0) 'none'
}
finally {
  if ($null -ne $proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
  try { Uninstall-App $installDir | Out-Null } catch { }
  Start-Sleep -Milliseconds 500
  # Do not remove default user data: this test owns only its temporary Base directory.
  Remove-TempBase $Base
}

[ordered]@{
  installer = $Installer
  base = $Base
  steps = $steps
  summary = [ordered]@{ passed = @($steps | Where-Object { $_.ok }).Count; failed = @($steps | Where-Object { -not $_.ok }).Count }
} | ConvertTo-Json -Depth 5
