@echo off
setlocal EnableExtensions EnableDelayedExpansion

REM ============================================================
REM  HomeChef one-click launcher for Windows
REM
REM  Flow:
REM    1. Probe for a free backend port (3001, then 3002, ...)
REM    2. Create ONE Windows Job Object and start the backend and the
REM       frontend as members of that job
REM    3. Wait for the backend health check and the frontend page
REM    4. Open the browser
REM    5. On key press, close the Job Object
REM
REM  SAFETY DESIGN (important):
REM    - Process ownership comes from the JOB OBJECT, not from a PID file.
REM      The job is created with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, so
REM      closing it ends exactly the processes that belong to the job.
REM      Processes outside the job are never affected.
REM    - Never uses "taskkill", in any form:
REM        no "taskkill /IM node.exe", no "taskkill /T", no "taskkill /F".
REM    - Never matches processes by name.
REM    - If a port is taken, it simply picks another port.
REM      It NEVER terminates whatever occupies the port (e.g. QQ Agent).
REM    - PID + start time are written to a log for diagnostics only.
REM      They are NOT used to decide what to stop.
REM
REM  NOTE: This file is intentionally ASCII-only. Chinese text inside a
REM  .bat combined with chcp 65001 breaks cmd.exe parsing on Windows.
REM ============================================================

title HomeChef

REM Always run from the directory containing this script
cd /d "%~dp0"

set "ROOT=%~dp0"
REM Trim the trailing backslash that %~dp0 always adds.
REM Without this, a path like "D:\HomeChef\" ends with \" which cmd reads
REM as an escaped quote and the quoting breaks.
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

set "HOST=127.0.0.1"
REM Diagnostics log only - never the authority for stopping anything.
set "RECORDFILE=%TEMP%\homechef_run_records.txt"
if exist "%RECORDFILE%" del /q "%RECORDFILE%" >nul 2>&1

echo.
echo ============================================
echo    HomeChef
echo ============================================
echo.

REM ------------------------------------------------------------
REM 0. Environment checks
REM ------------------------------------------------------------
where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js not found. Please install Node.js 20 or newer.
  echo.
  pause
  exit /b 1
)

if not exist "%ROOT%\node_modules" (
  echo [INFO] Dependencies not found. Running npm install ...
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo [ERROR] npm install failed.
    pause
    exit /b 1
  )
  echo.
)

REM ------------------------------------------------------------
REM 1. Pick a backend port
REM ------------------------------------------------------------
echo [1/4] Selecting backend port ...

set "BACKEND_PORT="
for /f "usebackq delims=" %%P in (`powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%\scripts\probe-port.ps1" -Start 3001 -End 3020`) do set "BACKEND_PORT=%%P"

if not defined BACKEND_PORT (
  echo [ERROR] Ports 3001-3020 are all in use. Cannot start the backend.
  echo         Nothing was terminated. Close some programs and retry.
  echo.
  pause
  exit /b 1
)

if "%BACKEND_PORT%"=="3001" (
  echo       Backend port: %BACKEND_PORT%
) else (
  echo       Backend port: %BACKEND_PORT%  ^(3001 was busy, moved up^)
  echo       The program occupying 3001 was NOT terminated.
)

set "FRONTEND_PORT="
for /f "usebackq delims=" %%P in (`powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%\scripts\probe-port.ps1" -Start 5173 -End 5192`) do set "FRONTEND_PORT=%%P"

if not defined FRONTEND_PORT (
  echo [ERROR] Ports 5173-5192 are all in use. Cannot start the frontend.
  echo.
  pause
  exit /b 1
)

echo       Frontend port: %FRONTEND_PORT%

set "BACKEND_URL=http://%HOST%:%BACKEND_PORT%"
set "FRONTEND_URL=http://%HOST%:%FRONTEND_PORT%"

REM ------------------------------------------------------------
REM 2. Start BOTH halves inside one Windows Job Object
REM
REM    scripts\homechef-job-holder.ps1 creates a job with
REM    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, launches the backend and the
REM    frontend as job members, and then stays alive holding the job handle.
REM
REM    Job membership - not a PID list - is the authority for ownership.
REM    Processes outside the job can never be touched.
REM
REM    The holder runs in its own window; that window is the HomeChef
REM    console. Closing it (or the stop signal below) ends the run.
REM ------------------------------------------------------------
echo.
echo [2/4] Starting backend and frontend inside one Job Object ...
echo       Backend : %BACKEND_URL%
echo       Frontend: %FRONTEND_URL%

set "STOPSIGNAL=%TEMP%\homechef_stop.signal"
if exist "%STOPSIGNAL%" del /q "%STOPSIGNAL%" >nul 2>&1

REM Launch the holder detached so this .bat keeps control of the console.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$a = @('-NoProfile','-ExecutionPolicy','Bypass','-File','%ROOT%\scripts\homechef-job-holder.ps1','-Root','%ROOT%','-BackendPort','%BACKEND_PORT%','-FrontendPort','%FRONTEND_PORT%','-ApiTarget','%BACKEND_URL%'); Start-Process -FilePath 'powershell.exe' -ArgumentList $a -WindowStyle Normal" >nul 2>&1

if errorlevel 1 (
  echo [ERROR] Failed to launch the Job Object holder.
  echo.
  pause
  exit /b 1
)

REM ------------------------------------------------------------
REM 3. Wait for the backend to answer its health check
REM ------------------------------------------------------------
echo.
echo [3/4] Waiting for the backend to become ready ...

set /a WAIT_COUNT=0
:WAIT_BACKEND
set /a WAIT_COUNT+=1
if %WAIT_COUNT% GTR 60 (
  echo [WARN] Backend not ready within 60s.
  echo        Check the HomeChef holder window for errors.
  goto BACKEND_DONE
)

powershell -NoProfile -Command "try { $r = Invoke-WebRequest -Uri '%BACKEND_URL%/health' -UseBasicParsing -TimeoutSec 2; if ($r.StatusCode -eq 200) { exit 0 } else { exit 1 } } catch { exit 1 }" >nul 2>&1
if errorlevel 1 (
  timeout /t 1 /nobreak >nul 2>&1
  goto WAIT_BACKEND
)

echo       Backend is ready (health check passed)

:BACKEND_DONE

REM ------------------------------------------------------------
REM 4. Wait for the frontend, then open the browser
REM ------------------------------------------------------------
echo.
echo [4/4] Waiting for the frontend, then opening the browser ...

set /a WAIT_COUNT=0
:WAIT_FRONTEND
set /a WAIT_COUNT+=1
if %WAIT_COUNT% GTR 60 (
  echo [WARN] Frontend not ready within 60s. Opening the browser anyway.
  goto FRONTEND_DONE
)

powershell -NoProfile -Command "try { $r = Invoke-WebRequest -Uri '%FRONTEND_URL%/' -UseBasicParsing -TimeoutSec 2; if ($r.StatusCode -eq 200) { exit 0 } else { exit 1 } } catch { exit 1 }" >nul 2>&1
if errorlevel 1 (
  timeout /t 1 /nobreak >nul 2>&1
  goto WAIT_FRONTEND
)

echo       Frontend is ready

:FRONTEND_DONE

start "" "%FRONTEND_URL%"

echo.
echo ============================================
echo    HomeChef is running
echo ============================================
echo.
echo    Frontend : %FRONTEND_URL%
echo    Backend  : %BACKEND_URL%
echo.
echo    Press any key = stop HomeChef
echo.
echo    Stopping closes the Job Object this run owns, so Windows ends
echo    exactly the processes of THIS run. Nothing outside the job -
echo    including any program on port 3001 - is affected.
echo.
echo ============================================
echo.

pause >nul

REM ------------------------------------------------------------
REM 5. Stop: close the Job Object
REM
REM    The holder owns the only handle to the job. Writing the stop signal
REM    makes it close that handle, and JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
REM    makes Windows terminate exactly the job's processes.
REM
REM    No taskkill. No /T. No /F. No name matching. No PID authority.
REM ------------------------------------------------------------
echo.
echo Stopping HomeChef (closing the Job Object) ...

echo stop > "%STOPSIGNAL%"

REM Give the holder a moment to close the job and exit.
REM The frontend port becoming free is the observable sign that the job's
REM processes are gone. We only observe - never terminate anything here.
set /a STOP_WAIT=0
:WAIT_STOP
set /a STOP_WAIT+=1
if %STOP_WAIT% GTR 20 goto STOP_DONE

powershell -NoProfile -Command "try { $c = Get-NetTCPConnection -LocalPort %FRONTEND_PORT% -State Listen -ErrorAction SilentlyContinue; if ($c) { exit 1 } else { exit 0 } } catch { exit 0 }" >nul 2>&1
if errorlevel 1 (
  timeout /t 1 /nobreak >nul 2>&1
  goto WAIT_STOP
)

:STOP_DONE

if exist "%STOPSIGNAL%" del /q "%STOPSIGNAL%" >nul 2>&1

echo.
echo HomeChef stop step finished.
echo Note: the Job Object was closed, so only this run's processes ended.
echo       Any program that was using port 3001 was untouched.
echo.
timeout /t 3 /nobreak >nul 2>&1

endlocal
exit /b 0
