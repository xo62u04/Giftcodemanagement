@echo off
chcp 65001 >nul
cd /d "%~dp0"

REM ============================================================
REM  電子禮券管理後台 啟動腳本（雙擊即可啟動）
REM  如需調整預設路徑，把下面的 SYNC_DIR / BACKUP_DIR 改成你們的 NAS 路徑，例如：
REM    set "SYNC_DIR=\\NAS01\giftcodes"
REM    set "BACKUP_DIR=\\NAS01\giftcodes-db"
REM  或已對應的網路磁碟機：
REM    set "SYNC_DIR=Z:\giftcodes"
REM    set "BACKUP_DIR=Z:\giftcodes-db"
REM ============================================================

set "PORT=3000"
set "SYNC_DIR=\\172.22.91.100\數位增長部\數位規劃處\【電子禮券後台】E-gift\gifts"
set "BACKUP_DIR=\\172.22.91.100\數位增長部\數位規劃處\【電子禮券後台】E-gift\DB"
set "SYNC_INTERVAL_MINUTES=30"

where node >nul 2>nul
if errorlevel 1 (
    echo [錯誤] 找不到 Node.js，請先到 https://nodejs.org 安裝 LTS 版（64 位元）。
    pause
    exit /b 1
)

if not exist node_modules (
    echo 第一次啟動，正在安裝相依套件...
    call npm install
    if errorlevel 1 (
        echo [錯誤] npm install 失敗，請確認網路連線後重試。
        pause
        exit /b 1
    )
)

echo.
echo 電子禮券管理後台啟動中... 瀏覽器開啟 http://localhost:%PORT%
echo 關閉此視窗即停止服務。
echo.
node src\server.js
pause
