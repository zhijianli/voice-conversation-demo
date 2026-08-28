# OpenAI Realtime Demo - Windows PowerShell launcher
# Usage: .\start.ps1

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Backend = Join-Path $Root "backend"
$Frontend = Join-Path $Root "frontend"
$Venv = Join-Path $Backend ".venv"
$VenvPy = Join-Path $Venv "Scripts\python.exe"
$VenvPip = Join-Path $Venv "Scripts\pip.exe"
$EnvFile = Join-Path $Backend ".env"
$EnvExample = Join-Path $Backend ".env.example"

Write-Host ""
Write-Host "========================================"
Write-Host "  OpenAI Realtime Demo - Windows 启动"
Write-Host "========================================"
Write-Host ""

function Require-Command($Name) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        Write-Host "[错误] 未找到 $Name，请先安装并加入 PATH。" -ForegroundColor Red
        exit 1
    }
}

Require-Command "python"
Require-Command "node"
Require-Command "npm"

if (-not (Test-Path $EnvFile)) {
    if (Test-Path $EnvExample) {
        Write-Host "[提示] 未找到 backend\.env，正在从 .env.example 复制..."
        Copy-Item $EnvExample $EnvFile
        Write-Host "[重要] 请先编辑 backend\.env 填入 OPENAI_API_KEY，然后重新运行。" -ForegroundColor Yellow
        notepad $EnvFile
        exit 1
    } else {
        Write-Host "[错误] 缺少 backend\.env 和 backend\.env.example" -ForegroundColor Red
        exit 1
    }
}

if (-not (Test-Path $VenvPy)) {
    Write-Host "[1/4] 创建 Python 虚拟环境..."
    & python -m venv $Venv
} else {
    Write-Host "[1/4] Python 虚拟环境已就绪"
}

Write-Host "[2/4] 安装 / 更新 Python 依赖..."
$env:PIP_CONFIG_FILE = ""
& $VenvPip install --isolated -r (Join-Path $Backend "requirements.txt") -q
if ($LASTEXITCODE -ne 0) {
    Write-Host "[警告] pip 安装可能失败。请检查网络或代理设置。" -ForegroundColor Yellow
    Write-Host "       你的 pip 全局配置可能含有无效代理: $env:APPDATA\pip\pip.ini"
    Write-Host "       可手动执行: cd backend; .\.venv\Scripts\pip install --isolated -r requirements.txt"
}

$NodeModules = Join-Path $Frontend "node_modules"
if (-not (Test-Path $NodeModules)) {
    Write-Host "[3/4] 安装前端依赖（首次运行可能需要几分钟）..."
    Push-Location $Frontend
    npm install
    if ($LASTEXITCODE -ne 0) {
        Pop-Location
        Write-Host "[错误] npm install 失败。" -ForegroundColor Red
        exit 1
    }
    Pop-Location
} else {
    Write-Host "[3/4] 前端依赖已就绪"
}

Write-Host "[4/4] 启动后端与前端..."
Write-Host ""
Write-Host "  后端: http://127.0.0.1:8000"
Write-Host "  前端: http://localhost:5173"
Write-Host ""
Write-Host "  关闭对应命令行窗口即可停止服务。"
Write-Host ""

$backendCmd = "cd /d `"$Backend`" && call .venv\Scripts\activate.bat && uvicorn main:app --reload --host 127.0.0.1 --port 8000"
Start-Process cmd.exe -ArgumentList "/k", $backendCmd -WindowStyle Normal

Start-Sleep -Seconds 2

$frontendCmd = "cd /d `"$Frontend`" && npm run dev"
Start-Process cmd.exe -ArgumentList "/k", $frontendCmd -WindowStyle Normal

Start-Sleep -Seconds 3
Start-Process "http://localhost:5173"

Write-Host "已在浏览器中打开 http://localhost:5173" -ForegroundColor Green
Write-Host "本窗口可以关闭。"
