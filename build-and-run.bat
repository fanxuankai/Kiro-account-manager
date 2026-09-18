@echo off
setlocal
title Kiro Account Manager - Build and Launch

echo ========================================================
echo   Kiro Account Manager - Build and Launch
echo ========================================================
echo.

set "ROOT_DIR=%~dp0"
set "APP_DIR=%ROOT_DIR%Kiro-account-manager"

if not exist "%APP_DIR%" (
    echo [ERROR] Cannot find directory: %APP_DIR%
    pause
    exit /b 1
)

cd /d "%APP_DIR%"

echo [1/2] Compiling production build...
call npm.cmd run build
if errorlevel 1 (
    echo.
    echo [ERROR] Build failed! Check errors above.
    pause
    exit /b 1
)
echo.

echo [2/2] Launching application...
set "ELECTRON_EXE=%APP_DIR%\node_modules\electron\dist\electron.exe"

if not exist "%ELECTRON_EXE%" (
    echo [ERROR] Electron executable not found!
    pause
    exit /b 1
)

echo Executable: %ELECTRON_EXE%
start "" "%ELECTRON_EXE%" .

echo.
echo Application started.
pause
exit /b 0
