# HomeChef port probe helper.
#
# Used by Start-HomeChef.bat to find the first available backend port.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File probe-port.ps1 -Start 3001 -End 3020
#
# It only tries to bind a TcpListener and releases it immediately.
# It NEVER terminates any process.
#
# NOTE: This file intentionally uses ASCII-only text so that it parses
# correctly under Windows PowerShell 5.1 regardless of file encoding.

param(
    [int]$Start = 3001,
    [int]$End = 3020
)

$bindHost = '127.0.0.1'

for ($p = $Start; $p -le $End; $p++) {
    $listener = $null
    try {
        $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Parse($bindHost), $p)
        $listener.Start()
        $listener.Stop()
        Write-Output $p
        exit 0
    }
    catch {
        if ($listener -ne $null) {
            try { $listener.Stop() } catch { }
        }
    }
}

exit 1
