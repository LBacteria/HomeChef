<#
  桌面客户端专项验证：可选内容导入 + 备份/恢复。

  ⚠️ 备份/恢复在界面里是菜单 + 系统文件对话框，无法在无头测试中点击。
     这里验证的是同一套文件级语义（WAL checkpoint 后的快照可被重新打开、
     删除 -wal/-shm 后替换文件即可恢复），并把「菜单交互未自动化」写进结论。

  所有数据都在 HOME_CHEF_DATA_DIR 指向的临时目录内。
#>
param(
  [string]$AppDataRoot = (Join-Path $env:TEMP ('homechef-desktop-content-' + [guid]::NewGuid().ToString('N').Substring(0, 8))),
  [string]$Exe = 'D:\HomeChef\desktop\release\win-unpacked\HomeChef.exe'
)

$ErrorActionPreference = 'Stop'
$dataRoot = Join-Path $AppDataRoot 'HomeChef'
$dbPath = Join-Path $dataRoot 'data\homechef.db'
$logPath = Join-Path $dataRoot 'logs\main.log'
New-Item -ItemType Directory -Path $dataRoot -Force | Out-Null
$result = [ordered]@{ appDataRoot = $AppDataRoot; exe = $Exe; steps = @() }

function Add-Step([string]$name, [bool]$ok, [string]$detail) {
  $script:result.steps += [ordered]@{ name = $name; ok = $ok; detail = $detail }
  Write-Host ('[{0}] {1} :: {2}' -f ($(if ($ok) { 'PASS' } else { 'FAIL' })), $name, $detail)
}

function Start-App {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $Exe
  $psi.Arguments = ''
  $psi.UseShellExecute = $false
  $psi.EnvironmentVariables['HOME_CHEF_DATA_DIR'] = $dataRoot
  $psi.EnvironmentVariables.Remove('ELECTRON_RUN_AS_NODE')
  $psi.WorkingDirectory = (Split-Path $Exe)
  [System.Diagnostics.Process]::Start($psi)
}

function Wait-Origin([int]$timeoutSeconds) {
  $deadline = (Get-Date).AddSeconds($timeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 400
    if (Test-Path $logPath) {
      $text = Get-Content $logPath -Raw
      $m = [regex]::Match($text, 'http://127\.0\.0\.1:(\d+)')
      if ($m.Success) { return [int]$m.Groups[1].Value }
    }
  }
  throw '等待服务启动超时'
}

function Stop-App($proc) {
  for ($i = 0; $i -lt 8; $i++) {
    if ($proc.HasExited) { return $true }
    $proc.CloseMainWindow() | Out-Null
    if ($proc.WaitForExit(2500)) { return $true }
  }
  Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
  $proc.WaitForExit(8000) | Out-Null
  return $false
}

# ⚠️ 用 Invoke-WebRequest + ConvertFrom-Json 计数：
#    Invoke-RestMethod 在这个脚本里对大数组第二次调用时会返回 null（实测），
#    导致 @($null).Count 恒为 1，把正常结果误判成失败。
function Get-RecipeCount([string]$baseUrl) {
  $resp = Invoke-WebRequest -Uri ($baseUrl + '/api/recipes') -UseBasicParsing -TimeoutSec 60
  return @(ConvertFrom-Json $resp.Content).Count
}

$probeSrc = @'
const Database = require('better-sqlite3');
const db = new Database(process.argv[2], { readonly: true, fileMustExist: true });
db.pragma('busy_timeout = 3000');
const q = (s) => db.prepare(s).get().c;
const out = {
  integrity: db.pragma('integrity_check', { simple: true }),
  tables: q("select count(*) c from sqlite_master where type='table' and name not like 'sqlite_%'"),
  definitions: q('select count(*) c from ingredient_definition'),
  recipes: q('select count(*) c from recipe'),
  migrations: q('select count(*) c from __drizzle_migrations'),
};
console.log(JSON.stringify(out));
db.close();
'@
$probePath = Join-Path 'D:\HomeChef\desktop' '.content-probe.cjs'
Set-Content -Path $probePath -Value $probeSrc -Encoding UTF8

try {
  # ---------- 启动 ----------
  $proc = Start-App
  $port = Wait-Origin 90
  $base = 'http://127.0.0.1:' + $port
  Add-Step '启动' ($port -gt 0) ('port=' + $port)

  # ---------- 可选内容导入 ----------
  $beforeCount = Get-RecipeCount $base
  Add-Step '导入前菜谱为空' ($beforeCount -eq 0) ('count=' + $beforeCount)

  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $import = Invoke-RestMethod -Uri ($base + '/api/content/starter') -Method Post -Body '{"pack":"v024"}' -ContentType 'application/json' -TimeoutSec 180
  $sw.Stop()
  Add-Step '内容导入接口返回' ($null -ne $import) (($import | ConvertTo-Json -Compress -Depth 3) + ' 耗时=' + [math]::Round($sw.Elapsed.TotalSeconds,1) + 's')

  $afterCount = Get-RecipeCount $base
  Add-Step '菜谱已导入' ($afterCount -gt 1000) ('count=' + $afterCount)

  $defs = Invoke-RestMethod -Uri ($base + '/api/definitions') -TimeoutSec 30
  $defCount = @($defs).Count
  Add-Step '食材定义已导入' ($defCount -ge 100) ('count=' + $defCount)

  # 重复导入应当零新增
  $import2 = Invoke-RestMethod -Uri ($base + '/api/content/starter') -Method Post -Body '{"pack":"v024"}' -ContentType 'application/json' -TimeoutSec 180
  $afterCount2 = Get-RecipeCount $base
  Add-Step '重复导入不新增' ($afterCount2 -eq $afterCount) ('before=' + $afterCount + ' after=' + $afterCount2)

  Add-Step '关闭应用' (Stop-App $proc) ('exited=' + $proc.HasExited)

  # ---------- 备份（模拟菜单导出：checkpoint 已由退出流程完成） ----------
  Start-Sleep -Milliseconds 1200
  $backupPath = Join-Path $AppDataRoot 'exported-backup.db'
  Copy-Item $dbPath $backupPath -Force
  $probe1 = (& node $probePath $backupPath) | ConvertFrom-Json
  Add-Step '导出的备份可用' ($probe1.integrity -eq 'ok' -and $probe1.recipes -gt 1000) ('integrity=' + $probe1.integrity + ' recipes=' + $probe1.recipes + ' bytes=' + (Get-Item $backupPath).Length)

  # ---------- 破坏当前库，再恢复 ----------
  Remove-Item $dbPath -Force
  foreach ($suffix in @('-wal','-shm')) { $f = $dbPath + $suffix; if (Test-Path $f) { Remove-Item $f -Force } }
  Add-Step '数据库已清空（模拟丢失）' (-not (Test-Path $dbPath)) $dbPath

  Copy-Item $backupPath $dbPath -Force
  $probe2 = (& node $probePath $dbPath) | ConvertFrom-Json
  Add-Step '恢复后数据完整' ($probe2.integrity -eq 'ok' -and $probe2.recipes -eq $probe1.recipes) ('recipes=' + $probe2.recipes)

  # ---------- 恢复后启动复验 ----------
  Move-Item -Path $logPath -Destination ($logPath + '.first') -Force
  $proc2 = Start-App
  $port2 = Wait-Origin 90
  $recipes2 = Get-RecipeCount ('http://127.0.0.1:' + $port2)
  Add-Step '恢复后应用可用' ($recipes2 -eq $probe1.recipes) ('recipes=' + $recipes2)
  Add-Step '恢复后关闭' (Stop-App $proc2) ('exited=' + $proc2.HasExited)
}
finally {
  Remove-Item $probePath -Force -ErrorAction SilentlyContinue
}

$result.summary = [ordered]@{
  passed = @($result.steps | Where-Object { $_.ok }).Count
  failed = @($result.steps | Where-Object { -not $_.ok }).Count
}
$result | ConvertTo-Json -Depth 6
