@echo off
chcp 65001 >nul
cd /d "%~dp0"

REM ============================================================
REM  E-gift admin startup script.
REM  Edit SYNC_DIR / BACKUP_DIR below if the default NAS paths change.
REM    set "SYNC_DIR=\\NAS01\giftcodes"
REM    set "BACKUP_DIR=\\NAS01\giftcodes-db"
REM  Or use mapped drives:
REM    set "SYNC_DIR=Z:\giftcodes"
REM    set "BACKUP_DIR=Z:\giftcodes-db"
REM ============================================================

set "PORT=3000"
set "SYNC_DIR=\\172.22.91.100\數位增長部\數位規劃處\【電子禮券後台】E-gift\gifts"
set "BACKUP_DIR=\\172.22.91.100\數位增長部\數位規劃處\【電子禮券後台】E-gift\DB"
set "SYNC_INTERVAL_MINUTES=30"

where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js was not found. Install the LTS version from https://nodejs.org.
    pause
    exit /b 1
)

if not exist node_modules (
    echo First run: installing dependencies...
    call npm install
    if errorlevel 1 (
        echo [ERROR] npm install failed. Check the network connection and try again.
        pause
        exit /b 1
    )
)

set "PORT_PID="
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R /C:":%PORT% .*LISTENING"') do set "PORT_PID=%%P"
if defined PORT_PID (
    echo.
    echo [INFO] Server is already running on port %PORT% ^(PID %PORT_PID%^).
    echo Open http://localhost:%PORT%
    pause
    exit /b 0
)

echo.
echo Starting E-gift admin... Open http://localhost:%PORT%
echo Close this window to stop the service.
echo.
node src\server.js
pause
