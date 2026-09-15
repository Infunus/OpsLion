@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-local.ps1" -OpenWeekly
if errorlevel 1 (
    echo.
    echo The collector could not start. Please keep the error above for diagnosis.
    pause
)
endlocal
