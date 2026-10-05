# HomeChef Job Object launcher / stopper.
#
# ---------------------------------------------------------------------------
# WHY A JOB OBJECT
# ---------------------------------------------------------------------------
# PID-based bookkeeping cannot prove process ownership: PIDs get recycled and
# a PID file can go stale. Windows Job Objects solve this at kernel level:
#
#   - A job is created for this run only.
#   - Every process started inside the job (and all of its descendants, which
#     inherit the job) belongs to that job.
#   - The job is created with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, so closing
#     the job handle terminates exactly the processes in the job.
#   - Processes OUTSIDE the job can never be affected.
#
# No taskkill. No name matching. No reliance on PID files for ownership.
#
# ---------------------------------------------------------------------------
# HOW IT IS USED
# ---------------------------------------------------------------------------
#   Probe / start / stop are separate verbs so the .bat stays readable.
#
#     Start  : creates the job, launches the given command inside it,
#              writes a log record, and keeps the job handle alive.
#     Stop   : signals the running job holder to close the job.
#
# Because a job handle must stay open for the lifetime of the run, the job is
# owned by a small holder process that waits for either a stop signal or its
# own console to close.
#
# NOTE: ASCII-only so it parses under Windows PowerShell 5.1.
# ---------------------------------------------------------------------------

# ===========================================================================
# DEPRECATED - DO NOT USE
# ===========================================================================
# This file is an earlier, FLAWED draft and is not referenced by
# Start-HomeChef.bat. It kept the job handle inside a short-lived script, so
# the handle closed immediately and KILL_ON_JOB_CLOSE would have killed the
# backend right after startup.
#
# The working implementation is scripts\homechef-job-holder.ps1, which keeps
# the job handle alive in a long-running holder process.
#
# Retained only for reference; it is intentionally left unused.
# ===========================================================================

param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Start', 'Stop', 'Status')]
    [string]$Action,

    # Directory containing both halves of the app
    [string]$Root = '',

    # Backend port to expose to the backend process
    [string]$BackendPort = '',

    # Vite proxy target (full URL) for the frontend process
    [string]$ApiTarget = '',

    # Vite port
    [string]$FrontendPort = '',

    # Job name used to find the holder again when stopping
    [string]$JobName = 'HomeChefRun'
)

$ErrorActionPreference = 'Stop'

# ===========================================================================
# Win32 interop
# ===========================================================================
if (-not ('HomeChefJobNative' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class HomeChefJobNative
{
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool SetInformationJobObject(
        IntPtr hJob, int JobObjectInfoClass, IntPtr lpJobObjectInfo, uint cbJobObjectInfoLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, int dwProcessId);

    // JOBOBJECT_EXTENDED_LIMIT_INFORMATION with KILL_ON_JOB_CLOSE
    [StructLayout(LayoutKind.Sequential)]
    public struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    public const int JobObjectExtendedLimitInformation = 9;
    public const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    public const uint PROCESS_SET_QUOTA = 0x0100;
    public const uint PROCESS_TERMINATE = 0x0001;

    public static bool EnableKillOnJobClose(IntPtr hJob)
    {
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

        int length = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        IntPtr ptr = Marshal.AllocHGlobal(length);
        try
        {
            Marshal.StructureToPtr(info, ptr, false);
            return SetInformationJobObject(hJob, JobObjectExtendedLimitInformation, ptr, (uint)length);
        }
        finally
        {
            Marshal.FreeHGlobal(ptr);
        }
    }

    public static bool AddProcessById(IntPtr hJob, int pid)
    {
        IntPtr hProc = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, pid);
        if (hProc == IntPtr.Zero) return false;
        try
        {
            return AssignProcessToJobObject(hJob, hProc);
        }
        finally
        {
            CloseHandle(hProc);
        }
    }
}
'@
}

# ===========================================================================
# Action: Start
#   Creates the job, launches cmd.exe inside it, keeps the job handle open
#   until told to stop. All descendants inherit the job automatically.
# ===========================================================================
function Invoke-Start {
    $jobName = $JobName + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)

    $hJob = [HomeChefJobNative]::CreateJobObject([IntPtr]::Zero, $jobName)
    if ($hJob -eq [IntPtr]::Zero) {
        Write-Output 'ERROR: CreateJobObject failed'
        exit 1
    }

    if (-not [HomeChefJobNative]::EnableKillOnJobClose($hJob)) {
        Write-Output 'ERROR: SetInformationJobObject failed'
        exit 1
    }

    # Marker file lets the .bat hand the job name to the stop step.
    $marker = Join-Path $env:TEMP 'homechef_job_name.txt'
    Set-Content -Path $marker -Value $jobName -Encoding ASCII

    # Launch the backend command inside a new console window.
    $backendCmd = 'cd /d "' + $Root + '" && set PORT=' + $BackendPort + ' && npm run dev:server'
    $p = Start-Process -FilePath 'cmd.exe' -ArgumentList '/k', $backendCmd -PassThru -WindowStyle Normal

    if (-not [HomeChefJobNative]::AddProcessById($hJob, $p.Id)) {
        Write-Output 'ERROR: AssignProcessToJobObject failed for backend'
        exit 1
    }

    # Record for logs only. NOT used as the authority for stopping.
    $logFile = Join-Path $env:TEMP 'homechef_run_records.txt'
    $rec = '' + $p.Id + '|' + $p.StartTime.Ticks + '|' + $p.ProcessName + '|backend|job=' + $jobName
    Add-Content -Path $logFile -Value $rec

    Write-Output ('JOBNAME=' + $jobName)
    Write-Output ('BACKEND_PID=' + $p.Id)
}

# ===========================================================================
# Action: Stop
#   Closes the job. KILL_ON_JOB_CLOSE makes Windows terminate exactly the
#   processes that were assigned to (or inherited) the job.
# ===========================================================================
function Invoke-Stop {
    $marker = Join-Path $env:TEMP 'homechef_job_name.txt'
    if (-not (Test-Path $marker)) {
        Write-Output '  no job marker found; nothing to stop'
        return
    }

    $jobName = (Get-Content $marker -Raw).Trim()
    if ([string]::IsNullOrWhiteSpace($jobName)) {
        Write-Output '  job marker empty; nothing to stop'
        return
    }

    # Opening the job by name and closing the handle triggers
    # KILL_ON_JOB_CLOSE only when the last handle closes. The holder process
    # holds a handle, so ask it to exit instead: its handle closing is what
    # fires the kill.
    $holder = Get-Process -ErrorAction SilentlyContinue |
              Where-Object { $_.ProcessName -eq 'powershell' -and $_.MainWindowTitle -like '*HomeChefJobHolder*' }

    if ($holder) {
        foreach ($h in $holder) {
            Write-Output ('  signalling job holder PID ' + $h.Id)
            $h.CloseMainWindow() | Out-Null
        }
    }
    else {
        Write-Output '  job holder not found (it may already have exited)'
    }

    Remove-Item $marker -Force -ErrorAction SilentlyContinue
}

# ===========================================================================
# Action: Status (diagnostics only)
# ===========================================================================
function Invoke-Status {
    $marker = Join-Path $env:TEMP 'homechef_job_name.txt'
    if (Test-Path $marker) {
        Write-Output ('JOBNAME=' + (Get-Content $marker -Raw).Trim())
    }
    else {
        Write-Output 'JOBNAME=(none)'
    }
}

switch ($Action) {
    'Start'  { Invoke-Start }
    'Stop'   { Invoke-Stop }
    'Status' { Invoke-Status }
}
