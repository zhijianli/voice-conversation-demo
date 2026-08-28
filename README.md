# OpenAI Realtime API 语音对话 Demo

基于 OpenAI Realtime API 的实时语音对话示例，前端 React + 后端 Python (FastAPI)。

## 架构

```
浏览器 (React)
  │  WebRTC + DataChannel
  │  POST /api/session (SDP)
  ▼
Python 后端 (FastAPI)
  │  代理 SDP + 会话配置
  ▼
OpenAI Realtime API
  wss://api.openai.com/v1/realtime/calls
```

- **前端**：通过 WebRTC 与 OpenAI 建立低延迟音频通道，DataChannel 接收转写文本事件
- **后端**：持有 API Key，代理 SDP 握手并注入会话配置（模型、语音、中文指令等），Key 不会暴露给浏览器

## 前置要求

- Python 3.10+
- Node.js 18+
- 有效的 [OpenAI API Key](https://platform.openai.com/api-keys)（需开通 Realtime API 权限）

## 快速开始

### 1. 配置 API Key

```bash
cp backend/.env.example backend/.env
# 编辑 backend/.env，填入你的 OPENAI_API_KEY
```

### 2. 启动后端

```bash
cd backend
python -m venv .venv

# Windows
.venv\Scripts\activate

# macOS / Linux
source .venv/bin/activate

pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

### 3. 启动前端

```bash
cd frontend
npm install
npm run dev
```

打开浏览器访问 http://localhost:5173 ，点击「开始对话」，允许麦克风权限后即可说话。

## 功能

- 实时语音对话（Server VAD 自动检测说话起止）
- 用户 / AI 语音转写实时显示
- 连接状态与麦克风活动指示
- 中文系统指令，AI 用中文简洁回复

## 配置

在 `backend/.env` 中可修改：

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `OPENAI_API_KEY` | OpenAI API 密钥 | （必填） |
| `REALTIME_MODEL` | Realtime 模型 | `gpt-realtime-2.1` |

会话配置（语音、指令、VAD 等）在 `backend/main.py` 的 `SESSION_CONFIG` 中修改。

## 注意事项

- Realtime API 按用量计费，测试前请确认账户余额
- 浏览器需 HTTPS 或 localhost 才能访问麦克风
- 若模型不可用，可尝试改为 `gpt-4o-realtime-preview` 等你有权限的模型

## 项目结构

```
gpt-realtime-demo/
├── backend/
│   ├── main.py           # FastAPI 服务
│   ├── requirements.txt
│   └── .env.example
├── frontend/
│   ├── src/
│   │   ├── hooks/useRealtime.ts   # WebRTC 连接逻辑
│   │   ├── components/VoiceChat.tsx
│   │   └── App.tsx
│   └── package.json
└── README.md
```
