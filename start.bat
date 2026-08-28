@echo off
setlocal EnableDelayedExpansion

set "ROOT=%~dp0"
set "BACKEND=%ROOT%backend"
set "FRONTEND=%ROOT%frontend"
set "VENV=%BACKEND%\.venv"
set "VENV_PY=%VENV%\Scripts\python.exe"
set "VENV_PIP=%VENV%\Scripts\pip.exe"

echo.
echo ========================================
echo   OpenAI Realtime Demo - Windows Start
echo ========================================
echo.

where python >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python not found. Install Python 3.10+ and add it to PATH.
    pause
    exit /b 1
)

where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js not found. Install Node.js 18+ and add it to PATH.
    pause
    exit /b 1
)

if not exist "%BACKEND%\.env" (
    if exist "%BACKEND%\.env.example" (
        echo [INFO] backend\.env not found, copying from .env.example ...
        copy "%BACKEND%\.env.example" "%BACKEND%\.env" >nul
        echo [ACTION] Edit backend\.env and set OPENAI_API_KEY, then run this script again.
        notepad "%BACKEND%\.env"
        pause
        exit /b 1
    ) else (
        echo [ERROR] Missing backend\.env and backend\.env.example
        pause
        exit /b 1
    )
)

set "NEED_VENV=0"
if not exist "%VENV_PY%" (
    set "NEED_VENV=1"
) else if exist "%VENV%\pyvenv.cfg" (
    findstr /I /C:"%VENV%" "%VENV%\pyvenv.cfg" >nul 2>&1
    if errorlevel 1 set "NEED_VENV=1"
)

if "!NEED_VENV!"=="1" (
    if exist "%VENV%" (
        echo [1/4] Virtual environment path is stale, recreating ...
        rmdir /s /q "%VENV%"
    ) else (
        echo [1/4] Creating Python virtual environment ...
    )
    python -m venv "%VENV%"
    if errorlevel 1 (
        echo [ERROR] Failed to create virtual environment.
        pause
        exit /b 1
    )
) else (
    echo [1/4] Python virtual environment ready
)

echo [2/4] Installing / updating Python dependencies ...
set "PIP_CONFIG_FILE="
"%VENV_PY%" -m pip install --isolated -r "%BACKEND%\requirements.txt"
if errorlevel 1 (
    echo [ERROR] pip install failed. Check network or proxy settings.
    echo        Manual fix: cd backend ^&^& .venv\Scripts\python.exe -m pip install --isolated -r requirements.txt
    echo        Or edit %%APPDATA%%\pip\pip.ini and remove invalid proxy setting.
    pause
    exit /b 1
)

if not exist "%FRONTEND%\node_modules" (
    echo [3/4] Installing frontend dependencies - first run may take a while ...
    pushd "%FRONTEND%"
    call npm install
    if errorlevel 1 (
        popd
        echo [ERROR] npm install failed.
        pause
        exit /b 1
    )
    popd
) else (
    echo [3/4] Frontend dependencies ready
)

echo [4/4] Starting backend and frontend ...
echo.
echo   Backend:  http://127.0.0.1:8000
echo   Frontend: http://localhost:5173/realtime/
echo.
echo   Close the backend/frontend windows to stop services.
echo.

start "Realtime Backend" /D "%BACKEND%" cmd /k ""%VENV_PY%" -m uvicorn main:app --reload --host 127.0.0.1 --port 8000"

timeout /t 2 /nobreak >nul

start "Realtime Frontend" /D "%FRONTEND%" cmd /k "npm run dev"

timeout /t 3 /nobreak >nul

start "" "http://localhost:5173/realtime/"

echo Browser opened: http://localhost:5173/realtime/
echo You can close this window now.
timeout /t 3 >nul

endlocal
