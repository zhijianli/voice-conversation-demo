from __future__ import annotations

import asyncio
import json
import os
from typing import Any

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, Query, Request, Response, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

load_dotenv(override=True)

from aws_voice import aws_voice_config, synthesize_speech, transcribe_websocket
from everecho_client import (
    bootstrap_free_coach_session,
    everecho_config,
    stream_free_coach_message,
)
from prompts import (
    LANGFUSE_CONSTITUTION_PROMPT_NAME,
    LANGFUSE_PROMPT_LABEL,
    LANGFUSE_PROMPT_NAME,
    get_instructions,
)

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
REALTIME_MODEL = os.getenv("REALTIME_MODEL", "gpt-realtime-2.1")
OPENAI_REALTIME_CALLS_URL = "https://api.openai.com/v1/realtime/calls"

AUDIO_CONFIG = {
    "input": {
        "turn_detection": {"type": "server_vad"},
        "transcription": {
            "model": "gpt-4o-mini-transcribe",
            "language": "zh",
        },
    },
    "output": {"voice": "marin"},
}


def build_session_config(*, use_langfuse: bool) -> dict:
    instructions, _ = get_instructions(use_langfuse=use_langfuse)
    return {
        "type": "realtime",
        "model": REALTIME_MODEL,
        "instructions": instructions,
        "audio": AUDIO_CONFIG,
    }


def json_error(message: str, status_code: int = 500, extra: dict[str, Any] | None = None):
    payload = {"error": message}
    if extra:
        payload.update(extra)
    return Response(
        content=json.dumps(payload, ensure_ascii=False),
        status_code=status_code,
        media_type="application/json",
    )


app = FastAPI(title="OpenAI Realtime Demo API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
async def health():
    return {
        "status": "ok",
        "model": REALTIME_MODEL,
        "langfuse_constitution": LANGFUSE_CONSTITUTION_PROMPT_NAME,
        "langfuse_node": LANGFUSE_PROMPT_NAME,
        "langfuse_label": LANGFUSE_PROMPT_LABEL,
        "free_coach": {
            **everecho_config(),
            **aws_voice_config(),
        },
    }


@app.post("/api/session")
async def create_session(
    request: Request,
    use_langfuse: bool = Query(False),
):
    if not OPENAI_API_KEY:
        return json_error("OPENAI_API_KEY 未配置，请检查 backend/.env")

    sdp = await request.body()
    if not sdp:
        return json_error("缺少 SDP 数据", 400)

    session_config = build_session_config(use_langfuse=use_langfuse)

    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.post(
            OPENAI_REALTIME_CALLS_URL,
            headers={"Authorization": f"Bearer {OPENAI_API_KEY}"},
            files=[
                ("sdp", (None, sdp, "application/sdp")),
                ("session", (None, json.dumps(session_config), "application/json")),
            ],
        )

    if response.status_code != 200 and response.status_code != 201:
        return json_error(
            "OpenAI Realtime API 请求失败",
            response.status_code,
            extra={"detail": response.text},
        )

    return Response(content=response.text, media_type="application/sdp")


@app.post("/api/free-coach/bootstrap")
async def free_coach_bootstrap():
    try:
        session = await bootstrap_free_coach_session()
    except Exception as exc:
        return json_error(str(exc), 502)
    return session


@app.post("/api/free-coach/messages")
async def free_coach_messages(request: Request):
    payload = await request.json()
    token = str(payload.get("token") or "").strip()
    conversation_id = str(payload.get("conversation_id") or "").strip()
    body = str(payload.get("body") or "").strip()
    client_temp_id = str(payload.get("client_temp_id") or "").strip() or None

    if not token or not conversation_id:
        return json_error("缺少 token 或 conversation_id", 400)
    if not body:
        return json_error("消息不能为空", 400)
    if len(body) > 8000:
        return json_error("消息过长", 400)

    return StreamingResponse(
        stream_free_coach_message(
            token=token,
            conversation_id=conversation_id,
            body=body,
            client_temp_id=client_temp_id,
        ),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.post("/api/free-coach/tts")
async def free_coach_tts(request: Request):
    payload = await request.json()
    text = str(payload.get("text") or "").strip()
    if not text:
        return json_error("TTS 文本为空", 400)

    try:
        audio, media_type = await asyncio_synthesize(text)
    except Exception as exc:
        return json_error(str(exc), 502)

    return Response(content=audio, media_type=media_type)


@app.websocket("/api/free-coach/transcribe")
async def free_coach_transcribe(websocket: WebSocket):
    await transcribe_websocket(websocket)


async def asyncio_synthesize(text: str) -> tuple[bytes, str]:
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, synthesize_speech, text)
