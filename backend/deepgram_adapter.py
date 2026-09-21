"""Deepgram Voice Agent 适配：WebSocket 代理 + Custom LLM → volo。"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import uuid
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect

from everecho_client import session_pool
from prompts import get_instructions
from s2s_common import b64, connect_upstream_ws, send_error, send_event, unb64

logger = logging.getLogger(__name__)

DEEPGRAM_API_KEY = os.getenv("DEEPGRAM_API_KEY", "").strip()
DEEPGRAM_AGENT_URL = os.getenv(
    "DEEPGRAM_AGENT_URL",
    "wss://agent.deepgram.com/v1/agent/converse",
)
DEEPGRAM_LISTEN_MODEL = os.getenv("DEEPGRAM_LISTEN_MODEL", "nova-3")
DEEPGRAM_SPEAK_MODEL = os.getenv("DEEPGRAM_SPEAK_MODEL", "aura-2-thalia-en")
DEEPGRAM_SPEAK_PROVIDER = os.getenv("DEEPGRAM_SPEAK_PROVIDER", "auto").strip().lower()
DEEPGRAM_OPENAI_TTS_VOICE = os.getenv("DEEPGRAM_OPENAI_TTS_VOICE", "nova")
DEEPGRAM_CUSTOM_LLM_SECRET = os.getenv("DEEPGRAM_CUSTOM_LLM_SECRET", "").strip()
DEEPGRAM_CUSTOM_LLM_MODEL = os.getenv("DEEPGRAM_CUSTOM_LLM_MODEL", "free-coach").strip()
DEEPGRAM_AGENT_LANGUAGE = os.getenv("DEEPGRAM_AGENT_LANGUAGE", "zh")

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "").strip()

_ws_sessions: dict[str, dict[str, Any]] = {}


def deepgram_config() -> dict[str, Any]:
    speak = _speak_provider()
    return {
        "configured": bool(DEEPGRAM_API_KEY),
        "listen_model": DEEPGRAM_LISTEN_MODEL,
        "speak_provider": speak.get("provider", {}).get("type"),
        "speak_voice": speak.get("provider", {}).get("voice") or speak.get("provider", {}).get("model"),
        "agent_language": DEEPGRAM_AGENT_LANGUAGE,
        "custom_llm_model": DEEPGRAM_CUSTOM_LLM_MODEL,
        "custom_llm_secret_configured": bool(DEEPGRAM_CUSTOM_LLM_SECRET),
    }


def _speak_provider() -> dict[str, Any]:
    if DEEPGRAM_SPEAK_PROVIDER == "openai" or (
        DEEPGRAM_SPEAK_PROVIDER == "auto" and OPENAI_API_KEY
    ):
        return {
            "provider": {
                "type": "open_ai",
                "model": "tts-1",
                "voice": DEEPGRAM_OPENAI_TTS_VOICE,
            },
            "endpoint": {
                "url": "https://api.openai.com/v1/audio/speech",
                "headers": {"authorization": f"Bearer {OPENAI_API_KEY}"},
            },
        }
    return {
        "provider": {
            "type": "deepgram",
            "version": "v1",
            "model": DEEPGRAM_SPEAK_MODEL,
        }
    }


def build_settings(
    *,
    session_id: str,
    llm_url: str,
    use_langfuse: bool,
) -> dict[str, Any]:
    instructions, _ = get_instructions(use_langfuse=use_langfuse)
    headers: dict[str, str] = {"X-Session-Id": session_id}
    if DEEPGRAM_CUSTOM_LLM_SECRET:
        headers["authorization"] = f"Bearer {DEEPGRAM_CUSTOM_LLM_SECRET}"

    speak = _speak_provider()
    return {
        "type": "Settings",
        "tags": ["voice-conversation-demo", "deepgram"],
        "audio": {
            "input": {"encoding": "linear16", "sample_rate": 16000},
            "output": {
                "encoding": "linear16",
                "sample_rate": 24000,
                "container": "none",
            },
        },
        "agent": {
            "language": DEEPGRAM_AGENT_LANGUAGE,
            "listen": {
                "provider": {
                    "type": "deepgram",
                    "model": DEEPGRAM_LISTEN_MODEL,
                    "smart_format": True,
                }
            },
            "think": {
                "provider": {
                    "type": "open_ai",
                    "model": DEEPGRAM_CUSTOM_LLM_MODEL,
                    "temperature": 0.7,
                },
                "endpoint": {"url": llm_url, "headers": headers},
                "prompt": instructions,
            },
            "speak": speak,
        },
    }


def public_page_config(request_base_url: str = "") -> dict[str, Any]:
    llm_url = f"{request_base_url.rstrip('/')}/deepgram/v1/chat/completions" if request_base_url else ""
    speak = _speak_provider()
    return {
        **deepgram_config(),
        "custom_llm_url": llm_url,
        "transport": "websocket",
        "speak_label": speak.get("provider", {}).get("voice")
        or speak.get("provider", {}).get("model"),
    }


async def ensure_ws_session(session_id: str) -> dict[str, Any]:
    existing = _ws_sessions.get(session_id)
    if existing:
        return existing
    bootstrapped = await session_pool.take()
    session = {
        "token": bootstrapped["token"],
        "conversation_id": bootstrapped["conversation_id"],
    }
    _ws_sessions[session_id] = session
    return session


def pop_ws_session(session_id: str) -> None:
    _ws_sessions.pop(session_id, None)


def get_ws_session(session_id: str) -> dict[str, Any] | None:
    return _ws_sessions.get(session_id)


def custom_llm_authorized(authorization: str | None, session_header: str | None) -> bool:
    if not DEEPGRAM_CUSTOM_LLM_SECRET:
        return True
    token = (authorization or "").removeprefix("Bearer ").strip()
    return bool(token and token == DEEPGRAM_CUSTOM_LLM_SECRET)


async def _wait_for_message(upstream, *, expected: str, timeout: float = 15.0) -> dict[str, Any]:
    async def _recv_once() -> dict[str, Any]:
        message = await upstream.recv()
        if isinstance(message, bytes):
            return {"_binary": message}
        return json.loads(message)

    while True:
        payload = await asyncio.wait_for(_recv_once(), timeout=timeout)
        if payload.get("_binary"):
            continue
        if payload.get("type") == expected:
            return payload
        if payload.get("type") == "Error":
            raise RuntimeError(str(payload.get("message") or payload))


async def _map_upstream_to_client(payload: dict[str, Any], client_ws: WebSocket) -> None:
    event_type = payload.get("type")
    if event_type == "UserStartedSpeaking":
        await send_event(client_ws, {"type": "input_audio_buffer.speech_started"})
        return
    if event_type == "ConversationText":
        role = payload.get("role")
        content = str(payload.get("content") or "").strip()
        if not content:
            return
        if role == "user":
            await send_event(
                client_ws,
                {
                    "type": "conversation.item.input_audio_transcription.completed",
                    "transcript": content,
                },
            )
            await send_event(client_ws, {"type": "input_audio_buffer.speech_stopped"})
        elif role == "assistant":
            await send_event(client_ws, {"type": "response.created"})
            await send_event(
                client_ws,
                {"type": "response.output_audio_transcript.done", "transcript": content},
            )
        return
    if event_type == "AgentStartedSpeaking":
        await send_event(client_ws, {"type": "response.created"})
        return
    if event_type == "AgentAudioDone":
        await send_event(client_ws, {"type": "response.done"})
        return
    if event_type == "Error":
        await send_event(
            client_ws,
            {"type": "error", "error": {"message": str(payload.get("message") or payload)}},
        )


async def handle_deepgram_ws(
    websocket: WebSocket,
    *,
    use_langfuse: bool = False,
    session_id: str = "",
    llm_url: str,
) -> None:
    if not DEEPGRAM_API_KEY:
        await websocket.accept()
        await send_error(websocket, "DEEPGRAM_API_KEY 未配置，请检查 backend/.env")
        await websocket.close()
        return

    session_key = (session_id or "").strip() or str(uuid.uuid4())
    await websocket.accept()
    upstream = None
    ready = asyncio.Event()

    try:
        await ensure_ws_session(session_key)
        upstream = await connect_upstream_ws(
            DEEPGRAM_AGENT_URL,
            headers={"Authorization": f"Token {DEEPGRAM_API_KEY}"},
        )
        await _wait_for_message(upstream, expected="Welcome")
        await upstream.send(
            json.dumps(
                build_settings(
                    session_id=session_key,
                    llm_url=llm_url,
                    use_langfuse=use_langfuse,
                ),
                ensure_ascii=False,
            )
        )
        await _wait_for_message(upstream, expected="SettingsApplied")
        await send_event(websocket, {"type": "session.ready", "session_id": session_key})
        ready.set()

        async def pump_client() -> None:
            try:
                while True:
                    message = await websocket.receive()
                    if message["type"] == "websocket.disconnect":
                        break
                    if not ready.is_set():
                        continue
                    data = message.get("bytes")
                    if data:
                        await upstream.send(data)
                        continue
                    text = message.get("text")
                    if not text:
                        continue
                    try:
                        payload = json.loads(text)
                    except json.JSONDecodeError:
                        continue
                    if payload.get("type") == "input_audio_buffer.append":
                        audio = payload.get("audio")
                        if audio:
                            await upstream.send(unb64(audio))
            except WebSocketDisconnect:
                pass
            except Exception:
                logger.exception("deepgram client pump failed")

        async def pump_upstream() -> None:
            try:
                async for message in upstream:
                    if isinstance(message, bytes):
                        await send_event(
                            websocket,
                            {
                                "type": "response.audio.delta",
                                "delta": b64(message),
                                "sample_rate": 24000,
                                "format": "pcm16",
                            },
                        )
                        continue
                    try:
                        payload = json.loads(message)
                    except json.JSONDecodeError:
                        continue
                    await _map_upstream_to_client(payload, websocket)
            except Exception:
                logger.exception("deepgram upstream pump failed")

        tasks = [
            asyncio.create_task(pump_client()),
            asyncio.create_task(pump_upstream()),
        ]
        done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            task.cancel()
        for task in done:
            with asyncio.suppress(asyncio.CancelledError):
                await task
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        logger.exception("deepgram voice agent failed")
        try:
            await send_error(websocket, str(exc))
        except Exception:
            pass
    finally:
        pop_ws_session(session_key)
        if upstream is not None:
            await upstream.close()
