@echo off
setlocal

set "BACKEND_DIR=%~dp0backend"
set "PORT=%PORT%"
if "%PORT%"=="" set "PORT=3000"
set "HOST=%HOST%"
if "%HOST%"=="" set "HOST=0.0.0.0"
set "OWNER_URL=http://%HOST%:%PORT%/owner"
set "NODE_EXE="
set "NPM_EXE="

if not exist "%BACKEND_DIR%\package.json" (
  echo [ERROR] package.json not found in backend folder.
  pause
  exit /b 1
)

call :findNode
if not defined NODE_EXE (
  echo [ERROR] Node.js was not found.
  echo [ERROR] Install Node.js LTS and re-run this file.
  pause
  exit /b 1
)

call :findNpm

if not exist "%BACKEND_DIR%\node_modules\" (
  if not defined NPM_EXE (
    echo [WARN] npm was not found, dependency install skipped.
    echo [WARN] If server fails to start, install Node.js fully ^(with npm^) and run again.
  ) else (
    echo [INFO] node_modules not found. Installing dependencies...
    call "%NPM_EXE%" --prefix "%BACKEND_DIR%" install
    if errorlevel 1 (
      echo [ERROR] npm install failed.
      pause
      exit /b 1
    )
  )
)

if not exist "%BACKEND_DIR%\node_modules\" (
  if defined NPM_EXE (
    echo [ERROR] node_modules is still missing after install attempt.
    pause
    exit /b 1
  )
)

echo [INFO] Stopping existing server on port %PORT% (if running)...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$port = [int]$env:PORT; $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue; if ($conn) { $pids = $conn | Select-Object -ExpandProperty OwningProcess -Unique; foreach ($procId in $pids) { Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue } }" >nul 2>nul

echo [INFO] Starting backend server on http://%HOST%:%PORT%...
echo [INFO] Backend will run in background. Log: %BACKEND_DIR%\server.start.log
pushd "%BACKEND_DIR%"
start "Cyber Stack Backend" /b "%NODE_EXE%" server.js > "%BACKEND_DIR%\server.start.log" 2>&1
popd

set "WAIT_OK=0"
for /L %%I in (1,1,20) do (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $r = Invoke-WebRequest -Uri ('http://' + $env:HOST + ':' + $env:PORT + '/health') -UseBasicParsing -TimeoutSec 2; if ($r.StatusCode -eq 200) { exit 0 } else { exit 1 } } catch { exit 1 }" >nul 2>nul
  if not errorlevel 1 (
    set "WAIT_OK=1"
    goto :ready
  )
  timeout /t 1 >nul
)

:ready
if "%WAIT_OK%"=="1" (
  echo [INFO] Server is up on http://%HOST%:%PORT%
  echo [INFO] Opening Owner Panel: %OWNER_URL%
  start "" "%OWNER_URL%"
  exit /b 0
)

echo [WARN] Server did not respond in time. Opening Owner Panel anyway.
start "" "%OWNER_URL%"

exit /b 0

:findNode
where /q node.exe
if not errorlevel 1 (
  for /f "delims=" %%P in ('where node.exe') do (
    set "NODE_EXE=%%P"
    goto :eof
  )
)

if exist "%ProgramFiles%\nodejs\node.exe" (
  set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
  goto :eof
)

if exist "%ProgramFiles(x86)%\nodejs\node.exe" (
  set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
  goto :eof
)
goto :eof

:findNpm
where /q npm.cmd
if not errorlevel 1 (
  for /f "delims=" %%P in ('where npm.cmd') do (
    set "NPM_EXE=%%P"
    goto :eof
  )
)

if exist "%ProgramFiles%\nodejs\npm.cmd" (
  set "NPM_EXE=%ProgramFiles%\nodejs\npm.cmd"
  goto :eof
)

if exist "%ProgramFiles(x86)%\nodejs\npm.cmd" (
  set "NPM_EXE=%ProgramFiles(x86)%\nodejs\npm.cmd"
  goto :eof
)
goto :eof
