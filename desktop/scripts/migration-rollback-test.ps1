<#
  主进程集成测试：恢复进来的库能通过结构校验、但迁移失败时，
  走的是「关闭连接 → 回滚原库 → 自动重启」这条真实路径。

  构造方法：
    1) 用真实迁移造两个库：A（正常，含用户数据）、B（复制 A 后删掉最后一条
       __drizzle_migrations 记录，仍能通过 inspect 的逐条比对）。
    2) 手工摆成「恢复做到一半」的现场：A 挪成 .restore-previous.db，
       B 放到 active 位置，并写合法的 pending 标记。
    3) 启动真实 exe：resolvePendingRestore 判定 ready → migrate 执行第 15 条
       迁移 → 因表和索引已存在而失败 → close → rollback → relaunch。
    4) 校验重启后跑的是回滚回来的 A，previous 与 marker 都已清理。
#>
param(
  [string]$Exe = 'D:\HomeChef\desktop\release\win-unpacked\HomeChef.exe',
  [string]$Base = (Join-Path $env:TEMP ('hc-mig-rollback-' + [guid]::NewGuid().ToString('N').Substring(0, 8)))
)
$ErrorActionPreference = 'Stop'
$desktop = 'D:\HomeChef\desktop'
$migrations = 'D:\HomeChef\server\drizzle'
$dataRoot = Join-Path $Base 'HomeChef'
$dataDir = Join-Path $dataRoot 'data'
$dbPath = Join-Path $dataDir 'homechef.db'
$prevPath = Join-Path $dataDir '.restore-previous.db'
$markerPath = Join-Path $dataDir '.restore-pending.json'
$logPath = Join-Path $dataRoot 'logs\main.log'
New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
$steps = @()
$startedAt = Get-Date
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

function Stop-All {
  Get-Process -Name 'HomeChef' -ErrorAction SilentlyContinue | Where-Object { $_.StartTime -ge $startedAt } | ForEach-Object {
    try { $_.CloseMainWindow() | Out-Null; if (-not $_.WaitForExit(4000)) { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue } } catch { }
  }
}

try {
  # ---------- 1. 造库 ----------
  # 放在 desktop 目录下，Node 才能沿目录树解析到仓库根部的 node_modules
  $prep = Join-Path $desktop '.mig-prep.cjs'
  $prepSrc = @'
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { drizzle } = require('drizzle-orm/better-sqlite3');
const { migrate } = require('drizzle-orm/better-sqlite3/migrator');
const [dbPath, migrations, badPath] = process.argv.slice(2);
const now = new Date().toISOString();
const a = new Database(dbPath);
migrate(drizzle(a), { migrationsFolder: migrations });
a.pragma('application_id = 1212377158');
a.prepare('insert into ingredient_definition (name, name_normalized, created_at, updated_at) values (?,?,?,?)')
  .run('原库数据-用户', '原库数据-用户', now, now);
a.close();
fs.copyFileSync(dbPath, badPath);
const b = new Database(badPath);
// 删最后两条（0013 recommendation_request / 0014 tag 迁移）：
// 0013 的 CREATE TABLE 没有 IF NOT EXISTS，重放必然因「表已存在」失败，
// 这样才能真正走到 migrate 抛错的分支。
b.prepare('delete from __drizzle_migrations where rowid in (select rowid from __drizzle_migrations order by rowid desc limit 2)').run();
b.close();
console.log('prepared');
'@
  Set-Content -Path $prep -Value $prepSrc -Encoding UTF8
  $badPath = Join-Path $Base 'bad-restored.db'
  $out = & node $prep $dbPath $migrations $badPath 2>&1
  $prepText = ($out | Out-String)
  Add-Step '构造恢复现场用库' ($prepText -match 'prepared') $prepText.Trim()

  # ---------- 2. 摆出「恢复做到一半」的状态 ----------
  Move-Item -Path $dbPath -Destination $prevPath -Force
  Copy-Item $badPath $dbPath -Force
  $marker = [ordered]@{
    version    = 1
    phase      = 'swapping'
    databasePath = $dbPath
    stagingPath  = (Join-Path $dataDir '.restore-staging.db')
    previousPath = $prevPath
    backupPath   = ''
    sourcePath   = $badPath
    startedAt    = (Get-Date).ToUniversalTime().ToString('o')
  } | ConvertTo-Json
  Set-Content -Path $markerPath -Value $marker -Encoding UTF8
  Add-Step '恢复现场已就位' ((Test-Path $prevPath) -and (Test-Path $markerPath)) 'previous + marker'

  # ---------- 3. 启动真实 exe ----------
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $Exe; $psi.Arguments = ''; $psi.UseShellExecute = $false
  $psi.EnvironmentVariables['HOME_CHEF_DATA_DIR'] = $dataRoot
  $psi.EnvironmentVariables.Remove('ELECTRON_RUN_AS_NODE')
  $psi.WorkingDirectory = Split-Path $Exe
  $first = [System.Diagnostics.Process]::Start($psi)

  $deadline = (Get-Date).AddSeconds(120)
  $rolledBack = $false
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    if (Test-Path $logPath) {
      $text = Get-Content $logPath -Raw
      if ($text -match '迁移失败，已回滚到恢复前的数据库') { $rolledBack = $true; break }
    }
  }
  Add-Step '主进程记录「迁移失败，已回滚」' $rolledBack 'log matched'

  # ---------- 4. 重启后应当跑回滚回来的原库 ----------
  $origin2 = 0
  $deadline = (Get-Date).AddSeconds(120)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    $text = Get-Content $logPath -Raw
    $ms = [regex]::Matches($text, 'http://127\.0\.0\.1:(\d+)')
    if ($ms.Count -ge 2) { $origin2 = [int]$ms[$ms.Count - 1].Groups[1].Value; break }
  }
  Add-Step '回滚后自动重启并再次服务' ($origin2 -gt 0) ('origin=' + $origin2)

  if ($origin2 -gt 0) {
    $port = $origin2
    $base2 = 'http://127.0.0.1:' + $port
    $defs = Invoke-RestMethod -Uri ($base2 + '/api/definitions') -TimeoutSec 15
    $names = @($defs) | ForEach-Object { $_.name }
    Add-Step '重启后读到的是原库数据' ($names -contains '原库数据-用户') ($names -join ',')
    $health = Invoke-RestMethod -Uri ($base2 + '/health') -TimeoutSec 10
    Add-Step '重启后服务健康' ($health.status -eq 'ok') ([string]$health.status)
  }

  Add-Step '恢复标记已清除' (-not (Test-Path $markerPath)) (Test-Path $markerPath)
  Add-Step '临时原库副本已清理' (-not (Test-Path $prevPath)) (Test-Path $prevPath)

  $check = & node -e "const D=require('better-sqlite3');const d=new D(process.argv[1],{readonly:true});console.log(JSON.stringify({m:d.prepare('select count(*) c from __drizzle_migrations').get().c,app:d.pragma('application_id',{simple:true})}));d.close()" $dbPath 2>&1
  $info = $check | ConvertFrom-Json
  Add-Step '回滚后的库迁移数完整' ($info.m -eq 15) ('migrations=' + $info.m + ' app_id=' + $info.app)
}
finally {
  Stop-All
  Start-Sleep -Milliseconds 800
  Stop-All
  Remove-Item (Join-Path $desktop '.mig-prep.cjs') -Force -ErrorAction SilentlyContinue
  # 只清理本测试创建的临时 Base：不碰默认用户数据目录。
  Remove-TempBase $Base
}

[ordered]@{
  exe = $Exe
  steps = $steps
  summary = [ordered]@{ passed = @($steps | Where-Object { $_.ok }).Count; failed = @($steps | Where-Object { -not $_.ok }).Count }
} | ConvertTo-Json -Depth 5
