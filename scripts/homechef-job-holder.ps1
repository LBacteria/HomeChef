# HomeChef Job Object holder.
#
# ---------------------------------------------------------------------------
# WHY A JOB OBJECT
# ---------------------------------------------------------------------------
# PID-based bookkeeping cannot prove process ownership: PIDs get recycled and a
# PID file can go stale. A Windows Job Object solves this at kernel level:
#
#   - One job is created for this run only.
#   - Every process started inside the job - and every descendant, which
#     inherits the job automatically - belongs to that job.
#   - The job carries JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, so closing the last
#     handle to the job makes Windows terminate exactly the job's processes.
#   - Processes outside the job can never be affected.
#
# No taskkill. No name matching. No PID file as the authority for ownership.
#
# ---------------------------------------------------------------------------
# WHY A HOLDER PROCESS
# ---------------------------------------------------------------------------
# The job handle must stay open for as long as HomeChef should run. If the
# handle lived in a short-lived script, it would close immediately and
# KILL_ON_JOB_CLOSE would kill the backend at once.
#
# So this script is launched ONCE and stays alive:
#
#   1. create job, enable KILL_ON_JOB_CLOSE
#   2. start the backend  (cmd.exe)  and assign it to the job
#   3. start the frontend (cmd.exe)  and assign it to the job
#   4. print a READY line so the .bat knows startup succeeded
#   5. wait for a stop signal file, or for this process's console to close
#   6. close the job handle -> Windows terminates only job members
#
# The .bat only starts this holder and creates the stop file. All process
# ownership lives in the job, not in any PID list.
#
# NOTE: ASCII-only so it parses under Windows PowerShell 5.1.
# ---------------------------------------------------------------------------

param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$BackendPort,
    [Parameter(Mandatory = $true)][string]$FrontendPort,
    [Parameter(Mandatory = $true)][string]$ApiTarget
)

$ErrorActionPreference = 'Stop'

$stopFile = Join-Path $env:TEMP 'homechef_stop.signal'
$logFile  = Join-Path $env:TEMP 'homechef_run_records.txt'
Remove-Item $stopFile -Force -ErrorAction SilentlyContinue

# ===========================================================================
# Win32 interop for Job Objects
# ===========================================================================
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

    public const int  JobObjectExtendedLimitInformation   = 9;
    public const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE  = 0x00002000;
    public const uint PROCESS_SET_QUOTA                   = 0x0100;
    public const uint PROCESS_TERMINATE                   = 0x0001;

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

# ===========================================================================
# 1. Create the job
# ===========================================================================
$jobName = 'HomeChefRun-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
$hJob = [HomeChefJobNative]::CreateJobObject([IntPtr]::Zero, $jobName)
if ($hJob -eq [IntPtr]::Zero) {
    Write-Output 'HOMECHEF_ERROR=CreateJobObject failed'
    exit 1
}

if (-not [HomeChefJobNative]::EnableKillOnJobClose($hJob)) {
    Write-Output 'HOMECHEF_ERROR=SetInformationJobObject failed'
    exit 1
}

# ===========================================================================
# 2. Launch both halves INSIDE the job
#
#    Assigning the cmd.exe root is enough: npm, node, tsx and Vite are all
#    descendants and inherit job membership automatically.
# ===========================================================================
function Start-InJob {
    param([string]$WorkDir, [string]$Command, [string]$Tag)

    $p = Start-Process -FilePath 'cmd.exe' `
                       -ArgumentList '/k', ('cd /d "' + $WorkDir + '" && ' + $Command) `
                       -PassThru -WindowStyle Normal

    if (-not [HomeChefJobNative]::AddProcessById($hJob, $p.Id)) {
        Write-Output ('HOMECHEF_ERROR=AssignProcessToJobObject failed for ' + $Tag)
        exit 1
    }

    # Log record only - diagnostics, NOT the authority for stopping.
    $rec = '' + $p.Id + '|' + $p.StartTime.Ticks + '|' + $p.ProcessName + '|' + $Tag + '|job=' + $jobName
    Add-Content -Path $logFile -Value $rec

    return $p.Id
}

$backendPid  = Start-InJob -WorkDir $Root `
                           -Command ('set PORT=' + $BackendPort + ' && npm run dev:server') `
                           -Tag 'backend'

$frontendPid = Start-InJob -WorkDir (Join-Path $Root 'client') `
                           -Command ('set HOME_CHEF_API_TARGET=' + $ApiTarget + ' && npx vite --port ' + $FrontendPort + ' --strictPort') `
                           -Tag 'frontend'

Write-Output 'HOMECHEF_READY=1'
Write-Output ('JOBNAME=' + $jobName)
Write-Output ('BACKEND_PID=' + $backendPid)
Write-Output ('FRONTEND_PID=' + $frontendPid)
[Console]::Out.Flush()

# ===========================================================================
# 3. Hold the job open until asked to stop
#
#    Two exit paths:
#      a) the .bat creates the stop-signal file
#      b) this console window is closed by the user
#    Either way we fall through to closing the job handle, and only then does
#    Windows terminate the job's processes.
# ===========================================================================
try {
    while ($true) {
        if (Test-Path $stopFile) { break }
        Start-Sleep -Milliseconds 500
    }
}
finally {
    # Closing the last job handle fires JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE.
    # Only processes inside this job are affected.
    [HomeChefJobNative]::CloseHandle($hJob) | Out-Null
    Remove-Item $stopFile -Force -ErrorAction SilentlyContinue
    Write-Output 'HOMECHEF_STOPPED=1'
}
