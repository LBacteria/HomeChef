# HomeChef process stop helper (identity-verified).
#
# Stops ONLY a process that can be positively identified as the one this
# launcher started. If identity cannot be confirmed, it does nothing.
#
# ---------------------------------------------------------------------------
# SAFETY DESIGN
# ---------------------------------------------------------------------------
# 1. Never matches by process name.
#    There is no "taskkill /IM node.exe" and no name-based filtering at all.
#
# 2. Does NOT trust a PID on its own.
#    A PID is only acted upon when ALL of the following match the values
#    captured at startup (see -ExpectedPid/-ExpectedStartTime/-ExpectedName):
#      - the PID exists
#      - its process start time equals the recorded start time
#      - its process name equals the recorded process name
#    A recycled PID fails the start-time check and is therefore skipped.
#
# 3. No forced tree kill.
#    Uses a graceful close first. It does NOT use "taskkill /T" and does
#    NOT use "taskkill /F" on arbitrary processes.
#
# 4. Refuses to touch anything that is not clearly ours.
#    If any check fails, the process is left completely untouched.
#
# NOTE: ASCII-only text so it parses under Windows PowerShell 5.1.
# ---------------------------------------------------------------------------

param(
    # Records captured at startup: "PID|StartTimeTicks|ProcessName"
    [Parameter(Mandatory = $true)]
    [string[]]$Record,

    [switch]$Quiet
)

function Write-Info($msg) {
    if (-not $Quiet) { Write-Output $msg }
}

$stopped = 0
$skipped = 0

foreach ($entry in $Record) {
    $parts = $entry.Split('|')
    if ($parts.Count -lt 3) {
        Write-Info ("  SKIP malformed record: " + $entry)
        $skipped++
        continue
    }

    $wantPid = 0
    if (-not [int]::TryParse($parts[0], [ref]$wantPid)) {
        Write-Info ("  SKIP non-numeric PID: " + $parts[0])
        $skipped++
        continue
    }
    $wantStart = $parts[1]
    $wantName = $parts[2]

    # ---- Identity verification -------------------------------------------
    $proc = Get-Process -Id $wantPid -ErrorAction SilentlyContinue

    if ($null -eq $proc) {
        # Process already exited. Nothing to do. Do NOT try to reuse the PID.
        Write-Info ("  SKIP PID " + $wantPid + ": no longer running")
        $skipped++
        continue
    }

    # Check 1: process name must match
    if ($proc.ProcessName -ne $wantName) {
        Write-Info ("  SKIP PID " + $wantPid + ": name mismatch (expected " + $wantName + ", found " + $proc.ProcessName + ")")
        $skipped++
        continue
    }

    # Check 2: start time must match exactly.
    # This is the key guard against PID reuse: a recycled PID belongs to a
    # process started at a different time.
    $actualStart = ''
    try {
        $actualStart = $proc.StartTime.Ticks.ToString()
    }
    catch {
        Write-Info ("  SKIP PID " + $wantPid + ": cannot read start time")
        $skipped++
        continue
    }

    if ($actualStart -ne $wantStart) {
        Write-Info ("  SKIP PID " + $wantPid + ": start time mismatch (PID was reused)")
        $skipped++
        continue
    }

    # ---- Identity confirmed ---------------------------------------------
    Write-Info ("  STOP PID " + $wantPid + " (" + $proc.ProcessName + ") - identity verified")

    # Graceful close only. No /F, no /T.
    # The child node processes exit on their own once their console closes.
    try {
        $closed = $proc.CloseMainWindow()
        if (-not $closed) {
            Write-Info ("    no main window to close; leaving process untouched")
            $skipped++
            continue
        }
    }
    catch {
        Write-Info ("    graceful close failed; leaving process untouched")
        $skipped++
        continue
    }

    # Give it a moment to exit on its own.
    $waited = 0
    while ($waited -lt 5) {
        Start-Sleep -Milliseconds 500
        $still = Get-Process -Id $wantPid -ErrorAction SilentlyContinue
        if ($null -eq $still) { break }
        $waited++
    }

    $final = Get-Process -Id $wantPid -ErrorAction SilentlyContinue
    if ($null -eq $final) {
        Write-Info ("    closed gracefully")
        $stopped++
    }
    else {
        # Still alive: do NOT escalate to a forced kill.
        # Leaving a stray console window open is strictly safer than risking
        # termination of a process we cannot fully account for.
        Write-Info ("    still running; NOT force-killed by design")
        Write-Info ("    close its window manually if desired")
        $skipped++
    }
}

Write-Info ("  summary: gracefully closed " + $stopped + ", skipped " + $skipped)

exit 0
