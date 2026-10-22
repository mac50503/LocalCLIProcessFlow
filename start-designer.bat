@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22 or newer is required. Install it from https://nodejs.org and run this file again.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing dependencies, first run only...
  call npm install
  if errorlevel 1 (
    echo npm install failed.
    pause
    exit /b 1
  )
)

echo Building designer...
call npm run build:designer >nul
if errorlevel 1 (
  echo Designer build failed. Run "npm run build:designer" to see the error.
  pause
  exit /b 1
)

if not defined LCPF_PORT set LCPF_PORT=7878
for /f %%i in ('powershell -NoProfile -Command "[guid]::NewGuid().ToString('N')"') do set LCPF_TOKEN=%%i

start "" /min powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep 3; Start-Process 'http://127.0.0.1:%LCPF_PORT%/#token=%LCPF_TOKEN%'"

echo Starting designer. Close this window or press Ctrl+C to stop it.
call npm run designer
pause
