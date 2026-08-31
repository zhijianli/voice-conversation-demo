from __future__ import annotations

import asyncio
import json
import logging
import os
from contextlib import asynccontextmanager
from typing import Any

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, Query, Request, Response, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

load_dotenv(override=True)

logger = logging.getLogger(__name__)

from aws_voice import (
    aws_voice_config,
    normalize_voice_language,
    synthesize_speech,
    transcribe_websocket,
    voice_profile,
)
from everecho_client import (
    everecho_config,
    session_pool,
    stream_free_coach_message,
)
from elevenlabs_adapter import (
    ELEVENLABS_AGENT_ID,
    ELEVENLABS_API_KEY,
    ELEVENLABS_BASE_URL,
    custom_llm_authorized,
    elevenlabs_adapter_config,
    iter_ui_events,
    public_page_config,
    stream_free_coach_as_openai,
)
from minimax_tts import (
    MINIMAX_PCM_SAMPLE_RATE,
    MINIMAX_PROVIDER,
    close_minimax_runtime,
    iter_minimax_pcm,
    resolve_minimax_voice,
    warmup_minimax,
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


@asynccontextmanager
async def lifespan(_app: FastAPI):
    warmup = asyncio.create_task(session_pool.warmup())
    tts_warmup = asyncio.create_task(warmup_minimax(force=True))
    try:
        yield
    finally:
        if not warmup.done():
            warmup.cancel()
        if not tts_warmup.done():
            tts_warmup.cancel()
        await close_minimax_runtime()


app = FastAPI(title="OpenAI Realtime Demo API", lifespan=lifespan)

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
            "session_pool": session_pool.snapshot(),
        },
        "elevenlabs_agent": elevenlabs_adapter_config(),
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
    asyncio.create_task(warmup_minimax())
    try:
        session = await session_pool.take()
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
    language = str(payload.get("language") or "en")
    if not text:
        return json_error("TTS 文本为空", 400)

    try:
        lang = normalize_voice_language(language)
    except ValueError as exc:
        return json_error(str(exc), 400)

    if lang == "zh" and MINIMAX_PROVIDER != "gmi":
        profile = dict(voice_profile(lang))
        profile["minimax_voice"] = resolve_minimax_voice(payload.get("voice_id"))

        async def pcm_chunks():
            min_bytes = int(MINIMAX_PCM_SAMPLE_RATE * 0.1) * 2
            pending = b""
            try:
                async for chunk in iter_minimax_pcm(text, profile):
                    if not chunk:
                        continue
                    pending += chunk
                    if len(pending) >= min_bytes:
                        yield pending
                        pending = b""
                if pending:
                    yield pending
            except Exception as exc:
                # Headers are already sent; raising here leaves the browser hanging
                # on an incomplete chunked body instead of showing an error.
                print(f"TTS stream failed: {exc}", flush=True)
                return

        return StreamingResponse(
            pcm_chunks(),
            media_type="application/octet-stream",
            headers={
                "Cache-Control": "no-cache, no-transform",
                "X-Accel-Buffering": "no",
                "X-Audio-Format": "pcm_s16le",
                "X-Sample-Rate": str(MINIMAX_PCM_SAMPLE_RATE),
            },
        )

    try:
        audio, media_type = await asyncio_synthesize(text, language)
    except ValueError as exc:
        return json_error(str(exc), 400)
    except Exception as exc:
        return json_error(str(exc), 502)

    return Response(content=audio, media_type=media_type)


@app.websocket("/api/free-coach/transcribe")
async def free_coach_transcribe(
    websocket: WebSocket,
    language: str = Query("en"),
):
    await transcribe_websocket(websocket, language)


def _public_api_base(request: Request) -> str:
    proto = (request.headers.get("x-forwarded-proto") or request.url.scheme or "https").split(",")[0].strip()
    host = (
        request.headers.get("x-forwarded-host")
        or request.headers.get("host")
        or request.url.netloc
    )
    if host in {"127.0.0.1:8000", "localhost:8000"}:
        return "http://127.0.0.1:8000/api"
    return f"{proto}://{host}/realtime/api"


@app.get("/api/elevenlabs/config")
async def elevenlabs_config(request: Request):
    return public_page_config(_public_api_base(request))


@app.get("/api/elevenlabs/conversation-token")
async def elevenlabs_conversation_token():
    if not ELEVENLABS_API_KEY:
        return json_error("ELEVENLABS_API_KEY 未配置", 500)
    if not ELEVENLABS_AGENT_ID:
        return json_error("ELEVENLABS_AGENT_ID 未配置", 500)
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            response = await client.get(
                f"{ELEVENLABS_BASE_URL}/v1/convai/conversation/token",
                params={"agent_id": ELEVENLABS_AGENT_ID},
                headers={"xi-api-key": ELEVENLABS_API_KEY},
            )
    except httpx.HTTPError as exc:
        return json_error(f"获取 ElevenLabs conversation token 失败：{exc}", 502)
    if response.status_code >= 400:
        detail = response.text[:500]
        message = "获取 ElevenLabs conversation token 失败"
        if "missing_permissions" in detail or "convai_write" in detail:
            message = (
                "ElevenLabs API key 缺少 convai_write 权限，无法签发 conversation token。"
                "当前 Agent 未开鉴权，页面会改用公开 Agent ID 连接。"
            )
        return json_error(
            message,
            response.status_code,
            extra={"detail": detail},
        )
    payload = response.json()
    token = payload.get("token") or payload.get("conversation_token")
    if not token:
        return json_error("ElevenLabs 未返回 conversation token", 502)
    return {"token": token}


@app.get("/api/elevenlabs/signed-url")
async def elevenlabs_signed_url():
    if not ELEVENLABS_API_KEY:
        return json_error("ELEVENLABS_API_KEY 未配置", 500)
    if not ELEVENLABS_AGENT_ID:
        return json_error("ELEVENLABS_AGENT_ID 未配置", 500)
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            response = await client.get(
                f"{ELEVENLABS_BASE_URL}/v1/convai/conversation/get-signed-url",
                params={"agent_id": ELEVENLABS_AGENT_ID},
                headers={"xi-api-key": ELEVENLABS_API_KEY},
            )
    except httpx.HTTPError as exc:
        return json_error(f"获取 ElevenLabs signed URL 失败：{exc}", 502)
    if response.status_code >= 400:
        return json_error(
            "获取 ElevenLabs signed URL 失败",
            response.status_code,
            extra={"detail": response.text[:500]},
        )
    payload = response.json()
    signed_url = payload.get("signed_url")
    if not signed_url:
        return json_error("ElevenLabs 未返回 signed_url", 502)
    return {"signed_url": signed_url}


@app.get("/api/elevenlabs/session-events/{session_id}")
async def elevenlabs_session_events(session_id: str):
    """前端旁路：尽早显示用户转写（Custom LLM 收到用户话时推送，跨 worker 文件总线）。"""
    key = (session_id or "").strip()
    if not key or len(key) > 128:
        return json_error("无效 session_id", 400)

    async def event_stream():
        async for event in iter_ui_events(key):
            if event.get("type") == "ping":
                yield ": ping\n\n"
                continue
            yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.post("/api/elevenlabs/v1/chat/completions")
async def elevenlabs_chat_completions(request: Request):
    if not custom_llm_authorized(
        request.headers.get("authorization"),
        request.headers.get("xi-api-key"),
    ):
        return json_error("Custom LLM 鉴权失败", 401)
    try:
        payload = await request.json()
    except Exception:
        return json_error("请求体不是 JSON", 400)
    if not isinstance(payload, dict):
        return json_error("请求体必须是对象", 400)

    async def event_stream():
        try:
            async for chunk in stream_free_coach_as_openai(payload):
                yield chunk
        except Exception as exc:
            logger.exception("elevenlabs custom llm failed")
            error = {"error": {"message": str(exc), "type": "server_error"}}
            yield f"data: {json.dumps(error, ensure_ascii=False)}\n\n".encode("utf-8")
            yield b"data: [DONE]\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


async def asyncio_synthesize(text: str, language: str = "en") -> tuple[bytes, str]:
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, synthesize_speech, text, language)
