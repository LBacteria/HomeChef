# Read-only Job Object membership inspection.
#
# Reports which processes belong to the HomeChef job created by this run.
# It does NOT modify or terminate anything.
#
# NOTE: ASCII-only.

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class JobQuery
{
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, int dwProcessId);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool QueryFullProcessImageName(IntPtr hProcess, uint dwFlags, StringBuilder lpExeName, ref uint lpdwSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool IsProcessInJob(IntPtr hProcess, IntPtr hJob, out bool result);

    public const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
}
'@

$jobName = ''
$marker = Join-Path $env:TEMP 'homechef_job_name.txt'

Write-Output '=== Job Object membership (read-only) ==='
Write-Output ''

# The holder named the job; we can find processes with that job by asking the
# processes we care about whether they are in *a* job.
# Since the job is unnamed from the outside for IsProcessInJob, we instead
# report job-related facts we can verify safely:
#   - the two recorded root processes
#   - their descendant tree
#   - whether each is in a job at all

function Get-Descendants {
    param([int]$RootPid)
    $all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CommandLine
    $result = @()
    $queue = @($RootPid)
    $seen = @{}
    while ($queue.Count -gt 0) {
        $cur = $queue[0]
        if ($queue.Count -gt 1) { $queue = $queue[1..($queue.Count - 1)] } else { $queue = @() }
        if ($seen.ContainsKey($cur)) { continue }
        $seen[$cur] = $true
        foreach ($p in $all) {
            if ($p.ParentProcessId -eq $cur) {
                $result += $p
                $queue += $p.ProcessId
            }
        }
    }
    return $result
}

$recFile = Join-Path $env:TEMP 'homechef_run_records.txt'
if (-not (Test-Path $recFile)) {
    Write-Output 'no run record found'
    exit 0
}

$records = Get-Content $recFile | Where-Object { $_ -match '\|' }
foreach ($rec in $records) {
    $parts = $rec.Split('|')
    $rootPid = [int]$parts[0]
    $tag = $parts[3]
    $job = $parts[4]

    Write-Output ('--- ' + $tag + ' (root PID ' + $rootPid + ', ' + $job + ') ---')

    $root = Get-CimInstance Win32_Process -Filter ("ProcessId = " + $rootPid) -ErrorAction SilentlyContinue
    if ($null -eq $root) {
        Write-Output '    root process: NOT RUNNING'
        continue
    }

    # Is it in a job?
    $h = [JobQuery]::OpenProcess([JobQuery]::PROCESS_QUERY_LIMITED_INFORMATION, $false, $rootPid)
    if ($h -ne [IntPtr]::Zero) {
        $inJob = $false
        $ok = [JobQuery]::IsProcessInJob($h, [IntPtr]::Zero, [ref]$inJob)
        [JobQuery]::CloseHandle($h) | Out-Null
        if ($ok) {
            Write-Output ('    root in a job : ' + $inJob)
        } else {
            Write-Output '    root in a job : (query failed)'
        }
    }

    $desc = Get-Descendants -RootPid $rootPid
    Write-Output ('    descendants   : ' + $desc.Count)
    foreach ($d in $desc) {
        $short = ''
        if ($d.CommandLine) {
            $short = $d.CommandLine
            if ($short.Length -gt 78) { $short = $short.Substring(0, 78) + '...' }
        }
        Write-Output ('      PID ' + $d.ProcessId + '  ' + $d.Name + '  ' + $short)
    }
    Write-Output ''
}

Write-Output '=== current listening ports ==='
foreach ($p in 3002, 5173) {
    $c = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue
    if ($c) { Write-Output ('  ' + $p + ' -> PID ' + $c.OwningProcess) }
    else { Write-Output ('  ' + $p + ' -> (not listening)') }
}
