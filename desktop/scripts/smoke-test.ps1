<#
  HomeChef 桌面客户端冒烟测试。

  隔离：用 HOME_CHEF_DATA_DIR 把整棵数据树（数据库、日志、Chromium 缓存）
  指到临时目录，不碰真实 %APPDATA%\HomeChef，也不碰仓库的 server/data。

  验证项：
    1. 启动后监听随机端口（不占 3001 / 5173）
    2. /health、首页静态资源、业务 API 可用
    3. 首次启动自动建库并执行全部迁移（完整性 + 外键无违规）
    4. 写入数据 → 关闭窗口 → 进程退出 → 端口释放
    5. 二次启动复用同一个库：数据仍在、迁移不重复执行

  ⚠️ 数据库探测只在应用进程退出之后执行：WAL 库在写入方仍持有时，
     只读连接可能阻塞，从而让测试卡死。
#>
param(
  [string]$AppDataRoot = (Join-Path $env:TEMP ('homechef-desktop-smoke-' + [guid]::NewGuid().ToString('N').Substring(0, 8))),
  # 传 -Exe 指向已打包的 HomeChef.exe，即可对安装产物做同样的验证。
  [string]$Exe = ''
)

$ErrorActionPreference = 'Stop'
$appDir = 'D:\HomeChef\desktop'
$packaged = $Exe -ne ''
$electron = if ($packaged) { $Exe } else { 'D:\HomeChef\node_modules\electron\dist\electron.exe' }
$dataRoot = Join-Path $AppDataRoot 'HomeChef'
$logPath = Join-Path $dataRoot 'logs\main.log'
$dbPath = Join-Path $dataRoot 'data\homechef.db'
New-Item -ItemType Directory -Path $dataRoot -Force | Out-Null
$result = [ordered]@{ appDataRoot = $AppDataRoot; steps = @() }
$script:started = @()

function Add-Step([string]$name, [bool]$ok, [string]$detail) {
  $script:result.steps += [ordered]@{ name = $name; ok = $ok; detail = $detail }
  Write-Host ('[{0}] {1} :: {2}' -f ($(if ($ok) { 'PASS' } else { 'FAIL' })), $name, $detail)
}

function Start-App {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $electron
  # 开发模式要把应用目录作为参数传给 electron；打包后的 exe 自带入口。
  $psi.Arguments = if ($packaged) { '' } else { '"' + $appDir + '"' }
  $psi.UseShellExecute = $false
  $psi.EnvironmentVariables['HOME_CHEF_DATA_DIR'] = $dataRoot
  # 本机执行环境会把 ELECTRON_RUN_AS_NODE 带进子进程，那样 Electron 退化成纯 Node。
  $psi.EnvironmentVariables.Remove('ELECTRON_RUN_AS_NODE')
  $psi.WorkingDirectory = $appDir
  $proc = [System.Diagnostics.Process]::Start($psi)
  $script:started += $proc
  return $proc
}

function Wait-Origin([int]$timeoutSeconds) {
  $deadline = (Get-Date).AddSeconds($timeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 400
    if (Test-Path $logPath) {
      $text = Get-Content $logPath -Raw
      $m = [regex]::Match($text, 'http://127\.0\.0\.1:(\d+)')
      if ($m.Success) { return [int]$m.Groups[1].Value }
      if ($text -match '启动失败') { throw ('启动失败：' + $text) }
    }
  }
  throw '等待服务启动超时'
}

function Stop-App($proc) {
  # 友好关闭窗口。CloseMainWindow 依赖 MainWindowHandle，对 Electron 不一定有效，
  # 所以再补一次 taskkill（不带 /F 也是发送关闭消息，不是强杀）。
  for ($i = 0; $i -lt 6; $i++) {
    if ($proc.HasExited) { return $true }
    $proc.CloseMainWindow() | Out-Null
    if ($proc.WaitForExit(2000)) { return $true }
    & taskkill /PID $proc.Id 2>&1 | Out-Null
    if ($proc.WaitForExit(3000)) { return $true }
  }
  Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
  $proc.WaitForExit(8000) | Out-Null
  return $false
}

$probeSrc = @'
const Database = require('better-sqlite3');
const db = new Database(process.argv[2], { readonly: true, fileMustExist: true });
db.pragma('busy_timeout = 3000');
const tables = db.prepare("select count(*) c from sqlite_master where type='table' and name not like 'sqlite_%'").get().c;
const migrations = db.prepare("select count(*) c from __drizzle_migrations").get().c;
const integrity = db.pragma('integrity_check', { simple: true });
const fk = db.pragma('foreign_key_check');
console.log(JSON.stringify({ tables, migrations, integrity, fkViolations: fk.length }));
db.close();
'@
# 放在 desktop 目录下，Node 才能沿目录树解析到仓库根部的 node_modules。
$probePath = Join-Path $appDir '.smoke-probe.cjs'
Set-Content -Path $probePath -Value $probeSrc -Encoding UTF8

try {
  # ---------- 第一次启动 ----------
  $proc = Start-App
  $port = Wait-Origin 90
  Add-Step '启动并监听随机端口' ($port -gt 0 -and $port -ne 3001 -and $port -ne 5173) ('port=' + $port)

  $health = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $port + '/health') -TimeoutSec 10
  Add-Step '健康检查' ($health.status -eq 'ok') ([string]$health.status)

  $page = Invoke-WebRequest -Uri ('http://127.0.0.1:' + $port + '/') -UseBasicParsing -TimeoutSec 10
  Add-Step '首页静态资源' ($page.StatusCode -eq 200 -and $page.Content -match 'HomeChef') ('status=' + $page.StatusCode + ' bytes=' + $page.RawContentLength)

  $apiPage = Invoke-WebRequest -Uri ('http://127.0.0.1:' + $port + '/api/settings') -UseBasicParsing -TimeoutSec 10
  Add-Step '业务 API 可用' ($apiPage.StatusCode -eq 200) ('status=' + $apiPage.StatusCode)

  Add-Step '数据库位于指定数据目录' (Test-Path $dbPath) $dbPath

  $body = @{ name = '冒烟测试食材'; units = @('个') } | ConvertTo-Json -Compress
  $created = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $port + '/api/definitions') -Method Post -Body $body -ContentType 'application/json; charset=utf-8' -TimeoutSec 10
  Add-Step '写入测试定义' ($null -ne $created.id) ('id=' + [string]$created.id)

  # ---------- 关闭窗口 ----------
  $graceful = Stop-App $proc
  # 必须优雅退出：强杀也会结束进程，但那样测不出退出流程是否正确。
  Add-Step '关闭窗口后优雅退出' ($graceful -eq $true) ('graceful=' + $graceful)

  Start-Sleep -Milliseconds 1500
  $still = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  Add-Step '端口已释放' ($null -eq $still) ('port=' + $port)

  # ---------- 应用已退出，此时再探测数据库 ----------
  $dbInfo = (& node $probePath $dbPath) | ConvertFrom-Json
  Add-Step '迁移全部执行' ($dbInfo.migrations -ge 15) ('migrations=' + $dbInfo.migrations + ' tables=' + $dbInfo.tables)
  Add-Step '完整性与外键' ($dbInfo.integrity -eq 'ok' -and $dbInfo.fkViolations -eq 0) ('integrity=' + $dbInfo.integrity + ' fkViolations=' + $dbInfo.fkViolations)

  # ---------- 第二次启动 ----------
  # 日志是追加写的；先归档，Wait-Origin 才不会读到第一次的端口。
  Move-Item -Path $logPath -Destination ($logPath + '.first') -Force
  $proc2 = Start-App
  $port2 = Wait-Origin 90
  Add-Step '二次启动成功' ($port2 -gt 0) ('port=' + $port2)

  $defs = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $port2 + '/api/definitions') -TimeoutSec 10
  $found = @($defs) | Where-Object { $_.name -eq '冒烟测试食材' }
  Add-Step '重启后数据仍在' ($null -ne $found) ('found=' + [bool]($null -ne $found))

  $graceful2 = Stop-App $proc2
  Add-Step '二次启动后优雅退出' ($graceful2 -eq $true) ('graceful=' + $graceful2)

  Start-Sleep -Milliseconds 1200
  $dbInfo2 = (& node $probePath $dbPath) | ConvertFrom-Json
  Add-Step '迁移未重复执行' ($dbInfo2.migrations -eq $dbInfo.migrations) ('before=' + $dbInfo.migrations + ' after=' + $dbInfo2.migrations)
  Add-Step '二次退出后数据库完整' ($dbInfo2.integrity -eq 'ok') ('integrity=' + $dbInfo2.integrity)
}
finally {
  Remove-Item $probePath -Force -ErrorAction SilentlyContinue
  # 无论断言成功与否，都清掉本次自己启动的进程，避免留下占端口的实例。
  foreach ($p in $script:started) {
    try {
      if (-not $p.HasExited) {
        Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
      }
    } catch {
      # 进程已经退出
    }
  }
}

$result.summary = [ordered]@{
  passed = @($result.steps | Where-Object { $_.ok }).Count
  failed = @($result.steps | Where-Object { -not $_.ok }).Count
}
$result | ConvertTo-Json -Depth 6
