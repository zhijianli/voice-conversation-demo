# 一键同步 & 部署指南

> **给 Cursor Agent 的说明**：当用户 `@DEPLOY.md` 并要求部署时，请按本文「Agent 执行清单」逐步执行，不要跳过验证步骤。
>
> **给用户**：本地改完代码后，在项目根目录运行 `.\scripts\sync-and-deploy.ps1` 即可。

---

## 环境信息

| 项 | 值 |
|----|-----|
| 本地目录 | `D:\github\voice-conversation-demo` |
| 服务器 | `ec2-user@3.142.136.175` |
| SSH Key | `C:\Users\zoruf\.ssh\everecho-aws.pem` |
| 项目目录 | `/home/ec2-user/projects/voice-conversation-demo` |
| 静态文件 | `/var/www/voice-conversation-demo/` |
| systemd 服务 | `voice-conversation-demo` |
| 生产访问地址 | https://api.volohorizon.com/realtime/ |

从旧目录 `gpt-realtime-demo` 迁过来时：把原来的 `backend/.env` 拷到新项目目录，并改 systemd `WorkingDirectory`、nginx `alias` 指向新路径。

---

## 用户一键部署（推荐）

在项目根目录 PowerShell 执行：

```powershell
.\scripts\sync-and-deploy.ps1
```

脚本会自动：

1. 打包本地源码（**不含** `node_modules`、`.venv`、`dist`、**`backend/.env`**）
2. `scp` 上传到 EC2
3. 远程：装 Python 依赖 → `npm run build` → 发布到 `/var/www` → 重启后端
4. 健康检查

---

## Agent 执行清单

用户 `@DEPLOY.md` 时，按顺序执行：

### 1. 确认本地在项目根目录

```powershell
Set-Location D:\github\voice-conversation-demo
```

### 2. 运行一键部署脚本

```powershell
.\scripts\sync-and-deploy.ps1
```

若脚本不存在或失败，改用手动步骤（见下方「手动部署步骤」）。

### 3. 验证部署成功

```powershell
curl.exe -sS https://api.volohorizon.com/realtime/api/health
curl.exe -sS -o NUL -w "frontend=%{http_code}`n" https://api.volohorizon.com/realtime/
```

期望：

- `/realtime/api/health` 返回 `{"status":"ok",...}`
- `/realtime/` 返回 HTTP `200`
- 云上 `free_coach.api_base` 应为 `http://127.0.0.1:3000/v1`（`api_base_mode` 为 `auto-local`）

### 4. 向用户汇报

- 部署是否成功
- 访问 URL：https://api.volohorizon.com/realtime/
- 若失败，贴出错误日志并排查

---

## 手动部署步骤（脚本失败时）

### Step A — 本地打包上传

```powershell
Set-Location D:\github\voice-conversation-demo
$tar = "$env:TEMP\voice-conversation-demo.tar.gz"
tar -czf $tar --exclude=node_modules --exclude=.venv --exclude=backend/.venv --exclude=frontend/dist --exclude=backend/.env --exclude=__pycache__ --exclude="*.pyc" .
scp -i "C:\Users\zoruf\.ssh\everecho-aws.pem" $tar ec2-user@3.142.136.175:/tmp/voice-conversation-demo.tar.gz
scp -i "C:\Users\zoruf\.ssh\everecho-aws.pem" scripts\remote-deploy.sh ec2-user@3.142.136.175:/tmp/remote-deploy.sh
```

### Step B — 远程构建发布

```powershell
ssh -i "C:\Users\zoruf\.ssh\everecho-aws.pem" ec2-user@3.142.136.175 "chmod +x /tmp/remote-deploy.sh && bash /tmp/remote-deploy.sh /tmp/voice-conversation-demo.tar.gz"
```

---

## 不会同步的内容

| 路径 | 原因 |
|------|------|
| `backend/.env` | 保护服务器上的密钥配置；需在服务器单独改 |
| `node_modules/`、`backend/.venv/` | 在服务器重新安装 |
| `frontend/dist/` | 在服务器重新 build |

若要同步 `.env` 到服务器（谨慎）：

```powershell
scp -i "C:\Users\zoruf\.ssh\everecho-aws.pem" backend\.env ec2-user@3.142.136.175:/home/ec2-user/projects/voice-conversation-demo/backend/.env
ssh -i "C:\Users\zoruf\.ssh\everecho-aws.pem" ec2-user@3.142.136.175 "sudo systemctl restart voice-conversation-demo"
```

不要把含密钥的 `.env` 推进 GitHub。

---

## 常用运维命令

```powershell
# 只看远程服务状态
ssh -i "C:\Users\zoruf\.ssh\everecho-aws.pem" ec2-user@3.142.136.175 "sudo systemctl status voice-conversation-demo --no-pager"

# 看后端日志
ssh -i "C:\Users\zoruf\.ssh\everecho-aws.pem" ec2-user@3.142.136.175 "sudo journalctl -u voice-conversation-demo -n 50 --no-pager"

# 仅重启后端（不改代码）
ssh -i "C:\Users\zoruf\.ssh\everecho-aws.pem" ec2-user@3.142.136.175 "sudo systemctl restart voice-conversation-demo"
```

---

## 架构速记

```
用户浏览器
  → https://api.volohorizon.com/realtime/                 （前端静态）
  → https://api.volohorizon.com/realtime/api/...          （本机 FastAPI :8000）
  → Free Coach：EC2 上 EverEcho http://127.0.0.1:3000/v1
  → STT Amazon Transcribe Streaming / TTS Amazon Polly (en) · MiniMax (zh)
  → OpenAI Realtime 页：WebRTC 音频直连 OpenAI
```

---

## 首次部署（服务器还没有环境时）

若全新机器，需先：

1. 上传项目并配置 `backend/.env`（可从旧的 `gpt-realtime-demo` 目录拷贝）
2. 配置 systemd：`/etc/systemd/system/voice-conversation-demo.service`（`WorkingDirectory` 指向 `/home/ec2-user/projects/voice-conversation-demo/backend`）
3. nginx `/realtime/` 的 `alias` 指向 `/var/www/voice-conversation-demo/`

日常更新只需 `.\scripts\sync-and-deploy.ps1`，无需重复首次步骤。
