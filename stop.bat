@echo off
setlocal EnableDelayedExpansion

echo.
echo ========================================
echo   Stop Realtime Demo Services
echo ========================================
echo.

set "FOUND=0"

for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8000 " ^| findstr "LISTENING"') do (
    echo Stopping backend PID=%%a (port 8000)
    taskkill /PID %%a /F >nul 2>&1
    set "FOUND=1"
)

for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":5173 " ^| findstr "LISTENING"') do (
    echo Stopping frontend PID=%%a (port 5173)
    taskkill /PID %%a /F >nul 2>&1
    set "FOUND=1"
)

if "!FOUND!"=="0" (
    echo No running services found on ports 8000 / 5173.
) else (
    echo.
    echo Services stopped.
)

echo.
pause

endlocal
