# 一键同步本地代码到 EC2 并部署
# 用法: .\scripts\sync-and-deploy.ps1
$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Key = "C:\Users\zoruf\.ssh\everecho-aws.pem"
$Host_ = "ec2-user@3.142.136.175"
$RemoteArchive = "/tmp/voice-conversation-demo.tar.gz"
$TarLocal = Join-Path $env:TEMP "voice-conversation-demo.tar.gz"

Write-Host ""
Write-Host "========================================"
Write-Host "  voice-conversation-demo 同步 + 部署"
Write-Host "========================================"
Write-Host ""

if (-not (Test-Path $Key)) {
  Write-Error "SSH key not found: $Key"
}

Push-Location $Root
try {
  Write-Host "[1/4] 打包源码（排除 node_modules / .venv / dist / .env）..."
  if (Test-Path $TarLocal) { Remove-Item $TarLocal -Force }
  tar -czf $TarLocal `
    --exclude=node_modules `
    --exclude=.venv `
    --exclude=backend/.venv `
    --exclude=frontend/dist `
    --exclude=backend/.env `
    --exclude=__pycache__ `
    --exclude="*.pyc" `
    .

  $sizeKb = [math]::Round((Get-Item $TarLocal).Length / 1KB, 1)
  Write-Host "       archive: $TarLocal ($sizeKb KB)"

  Write-Host "[2/4] 上传到 EC2..."
  scp -i $Key -o StrictHostKeyChecking=accept-new $TarLocal "${Host_}:${RemoteArchive}"

  Write-Host "[3/4] 远程构建 & 发布..."
  scp -i $Key "$Root\scripts\remote-deploy.sh" "${Host_}:/tmp/remote-deploy.sh"
  ssh -i $Key $Host_ "chmod +x /tmp/remote-deploy.sh && bash /tmp/remote-deploy.sh $RemoteArchive"

  Write-Host "[4/4] 完成"
  Write-Host ""
  Write-Host "  访问: https://api.volohorizon.com/realtime/" -ForegroundColor Green
  Write-Host ""
}
finally {
  Pop-Location
}
