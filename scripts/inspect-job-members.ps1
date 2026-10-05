# Read-only check: is a given PID actually inside the HomeChef job?
#
# Uses IsProcessInJob against the real job handle, opening the job by name.
# This is the kernel's answer, not a ParentProcessId inference.
#
# It does NOT modify or terminate anything.
#
# NOTE: ASCII-only.

param(
    [int[]]$CheckPid = @()
)

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class JobCheck
{
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr OpenJobObject(uint dwDesiredAccess, bool bInheritHandle, string lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, int dwProcessId);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool IsProcessInJob(IntPtr hProcess, IntPtr hJob, out bool result);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool QueryInformationJobObject(
        IntPtr hJob, int infoClass, IntPtr info, uint infoLength, out uint returnLength);

    public const uint JOB_OBJECT_QUERY = 0x0004;
    public const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    public const int JobObjectBasicProcessIdList = 3;

    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_BASIC_PROCESS_ID_LIST
    {
        public uint NumberOfAssignedProcesses;
        public uint NumberOfProcessIdsInList;
        public ulong ProcessIdList;
    }

    public static int[] GetJobProcessIds(IntPtr hJob)
    {
        // Allocate a buffer big enough for 512 PIDs.
        int headerSize = 8;
        int capacity = 512;
        int size = headerSize + capacity * 8;
        IntPtr buf = Marshal.AllocHGlobal(size);
        try
        {
            // Zero the header
            for (int i = 0; i < headerSize; i++) Marshal.WriteByte(buf, i, 0);

            uint ret = 0;
            bool ok = QueryInformationJobObject(hJob, JobObjectBasicProcessIdList, buf, (uint)size, out ret);
            if (!ok) return new int[0];

            uint count = (uint)Marshal.ReadInt32(buf, 4);
            int[] ids = new int[count];
            for (int i = 0; i < count; i++)
            {
                long v = Marshal.ReadInt64(buf, headerSize + i * 8);
                ids[i] = (int)v;
            }
            return ids;
        }
        finally
        {
            Marshal.FreeHGlobal(buf);
        }
    }
}
'@

$marker = Join-Path $env:TEMP 'homechef_job_name.txt'
$jobName = $null

if (Test-Path $marker) {
    $jobName = (Get-Content $marker -Raw).Trim()
}

# Fall back to the job name embedded in the run records written by the holder.
if ([string]::IsNullOrWhiteSpace($jobName)) {
    $recFile = Join-Path $env:TEMP 'homechef_run_records.txt'
    if (Test-Path $recFile) {
        $line = Get-Content $recFile | Where-Object { $_ -match 'job=' } | Select-Object -First 1
        if ($line) {
            $m = [regex]::Match($line, 'job=([^\s]+)')
            if ($m.Success) { $jobName = $m.Groups[1].Value }
        }
    }
}

if ([string]::IsNullOrWhiteSpace($jobName)) {
    Write-Output 'no job name found in marker or run records; cannot inspect'
    exit 0
}

Write-Output ('Job name: ' + $jobName)
Write-Output ''

$hJob = [JobCheck]::OpenJobObject([JobCheck]::JOB_OBJECT_QUERY, $false, $jobName)
if ($hJob -eq [IntPtr]::Zero) {
    Write-Output 'ERROR: could not open the job by name (it may have been closed)'
    Write-Output 'NOTE: the holder owns the only handle; after it exits the job is gone.'
    exit 0
}

Write-Output '=== KERNEL-VERIFIED job member list ==='
$ids = [JobCheck]::GetJobProcessIds($hJob)
Write-Output ('member count: ' + $ids.Count)
Write-Output ''

foreach ($id in $ids) {
    $proc = Get-CimInstance Win32_Process -Filter ("ProcessId = " + $id) -ErrorAction SilentlyContinue
    if ($proc) {
        $cl = ''
        if ($proc.CommandLine) {
            $cl = $proc.CommandLine
            if ($cl.Length -gt 72) { $cl = $cl.Substring(0, 72) + '...' }
        }
        Write-Output ('  PID ' + $id + '  ' + $proc.Name + '  ' + $cl)
    }
    else {
        Write-Output ('  PID ' + $id + '  (exited)')
    }
}

Write-Output ''
Write-Output '=== explicit membership questions ==='
foreach ($p in $CheckPid) {
    $h = [JobCheck]::OpenProcess([JobCheck]::PROCESS_QUERY_LIMITED_INFORMATION, $false, $p)
    if ($h -eq [IntPtr]::Zero) {
        Write-Output ('  PID ' + $p + ' : cannot open (process gone)')
        continue
    }
    $inJob = $false
    $ok = [JobCheck]::IsProcessInJob($h, $hJob, [ref]$inJob)
    [JobCheck]::CloseHandle($h) | Out-Null
    if ($ok) {
        Write-Output ('  PID ' + $p + ' : in THIS job = ' + $inJob)
    } else {
        Write-Output ('  PID ' + $p + ' : query failed')
    }
}

[JobCheck]::CloseHandle($hJob) | Out-Null
