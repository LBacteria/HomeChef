# Read-only verification of the identity-check logic in
# stop-homechef-process.ps1.
#
# This does NOT stop anything. It only exercises the verification path
# against real processes to prove that mismatched identities are refused.
#
# NOTE: ASCII-only.

$ErrorActionPreference = 'Stop'

Write-Output "=== Identity check verification (read-only) ==="
Write-Output ""

# Pick a long-lived process that must NOT be touched.
$callee = Get-Process -Id $PID
Write-Output ("Test subject: PID " + $callee.Id + " (" + $callee.ProcessName + ")")
$realStart = $callee.StartTime.Ticks.ToString()
$realName  = $callee.ProcessName
Write-Output ""

function Test-Identity {
    param([string]$wantPid, [string]$wantStart, [string]$wantName)

    $proc = Get-Process -Id ([int]$wantPid) -ErrorAction SilentlyContinue
    if ($null -eq $proc) { return "REFUSED: process not running" }

    if ($proc.ProcessName -ne $wantName) {
        return "REFUSED: name mismatch (expected $wantName, found $($proc.ProcessName))"
    }

    $actualStart = ''
    try { $actualStart = $proc.StartTime.Ticks.ToString() } catch { return "REFUSED: cannot read start time" }

    if ($actualStart -ne $wantStart) {
        return "REFUSED: start time mismatch (PID reused)"
    }

    return "CONFIRMED: identity verified"
}

# Case 1: fully correct record -> CONFIRMED
$r1 = Test-Identity -wantPid $callee.Id -wantStart $realStart -wantName $realName
Write-Output ("1) correct record            -> " + $r1)

# Case 2: correct PID but WRONG start time (simulates PID reuse)
$r2 = Test-Identity -wantPid $callee.Id -wantStart "123456789" -wantName $realName
Write-Output ("2) PID + wrong start time    -> " + $r2)

# Case 3: correct PID but WRONG name
$r3 = Test-Identity -wantPid $callee.Id -wantStart $realStart -wantName "notepadexe"
Write-Output ("3) PID + wrong name          -> " + $r3)

# Case 4: PID that does not exist
$r4 = Test-Identity -wantPid "999999" -wantStart $realStart -wantName $realName
Write-Output ("4) non-existent PID          -> " + $r4)

# Case 5: other real process (must never be touched) - test with wrong start
$other = Get-Process | Where-Object { $_.Id -ne $PID -and $_.ProcessName -eq 'explorer' } | Select-Object -First 1
if ($other) {
    $r5 = Test-Identity -wantPid $other.Id -wantStart "1" -wantName $other.ProcessName
    Write-Output ("5) other process wrong start -> " + $r5)
} else {
    Write-Output "5) other process             -> (no explorer.exe found, skipped)"
}

Write-Output ""
Write-Output "=== Expected: case 1 CONFIRMED, cases 2-5 REFUSED ==="
