"""Deepgram Nova 流式 STT WebSocket（兼容 Free Coach 前端协议）。"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from typing import Any
from urllib.parse import urlencode

from fastapi import WebSocket, WebSocketDisconnect
from starlette.websockets import WebSocketState

from s2s_common import connect_upstream_ws

logger = logging.getLogger(__name__)

DEEPGRAM_API_KEY = os.getenv("DEEPGRAM_API_KEY", "").strip()
DEEPGRAM_LISTEN_MODEL = os.getenv("DEEPGRAM_LISTEN_MODEL", "nova-3")
DEEPGRAM_LISTEN_BASE = os.getenv(
    "DEEPGRAM_LISTEN_BASE",
    "wss://api.deepgram.com/v1/listen",
)
TRANSCRIBE_SAMPLE_RATE = int(os.getenv("DEEPGRAM_TRANSCRIBE_SAMPLE_RATE", "16000"))

LANGUAGE_MAP = {
    "en": "en-US",
    "zh": "zh-CN",
}


def deepgram_transcribe_config() -> dict[str, Any]:
    return {
        "configured": bool(DEEPGRAM_API_KEY),
        "model": DEEPGRAM_LISTEN_MODEL,
        "sample_rate": TRANSCRIBE_SAMPLE_RATE,
    }


def _listen_url(language: str) -> str:
    params = {
        "model": DEEPGRAM_LISTEN_MODEL,
        "language": LANGUAGE_MAP.get(language, language),
        "encoding": "linear16",
        "sample_rate": TRANSCRIBE_SAMPLE_RATE,
        "channels": 1,
        "interim_results": "true",
        "punctuate": "true",
        "smart_format": "true",
        "endpointing": 300,
    }
    return f"{DEEPGRAM_LISTEN_BASE}?{urlencode(params)}"


async def _close_websocket(websocket: WebSocket) -> None:
    if websocket.client_state != WebSocketState.CONNECTED:
        return
    try:
        await websocket.close()
    except RuntimeError:
        pass


async def transcribe_websocket(websocket: WebSocket, language: str = "zh") -> None:
    if not DEEPGRAM_API_KEY:
        await websocket.accept()
        await websocket.send_text(
            json.dumps(
                {"type": "error", "message": "DEEPGRAM_API_KEY 未配置"},
                ensure_ascii=False,
            )
        )
        await _close_websocket(websocket)
        return

    await websocket.accept()
    try:
        await websocket.send_text(json.dumps({"type": "accepted"}, ensure_ascii=False))
    except RuntimeError:
        return

    lang = language if language in LANGUAGE_MAP else "zh"
    audio_queue: asyncio.Queue[bytes | None] = asyncio.Queue(maxsize=40)
    client_gone = asyncio.Event()

    async def read_client() -> None:
        try:
            while True:
                message = await websocket.receive()
                if message.get("type") == "websocket.disconnect":
                    break
                chunk = message.get("bytes")
                if chunk:
                    try:
                        audio_queue.put_nowait(chunk)
                    except asyncio.QueueFull:
                        pass
                    continue
                text = message.get("text")
                if not text:
                    continue
                try:
                    control = json.loads(text)
                except json.JSONDecodeError:
                    continue
                if control.get("type") in {"stop", "close"}:
                    break
        except WebSocketDisconnect:
            pass
        finally:
            client_gone.set()
            await audio_queue.put(None)

    async def pump_audio(upstream) -> None:
        try:
            while not client_gone.is_set():
                chunk = await audio_queue.get()
                if chunk is None:
                    await upstream.send(json.dumps({"type": "CloseStream"}))
                    break
                await upstream.send(chunk)
        except Exception:
            logger.exception("deepgram audio pump failed")

    async def pump_transcripts(upstream) -> None:
        try:
            async for message in upstream:
                if client_gone.is_set():
                    break
                if isinstance(message, bytes):
                    continue
                try:
                    payload = json.loads(message)
                except json.JSONDecodeError:
                    continue
                if payload.get("type") == "Metadata":
                    continue
                channel = payload.get("channel") or {}
                alternatives = channel.get("alternatives") or []
                if not alternatives:
                    continue
                text = str(alternatives[0].get("transcript") or "").strip()
                if not text:
                    continue
                is_final = bool(payload.get("is_final"))
                if websocket.client_state != WebSocketState.CONNECTED:
                    return
                await websocket.send_text(
                    json.dumps(
                        {
                            "type": "final" if is_final else "partial",
                            "text": text,
                        },
                        ensure_ascii=False,
                    )
                )
        except Exception:
            logger.exception("deepgram transcript pump failed")

    reader = asyncio.create_task(read_client())
    try:
        upstream = await connect_upstream_ws(
            _listen_url(lang),
            headers={"Authorization": f"Token {DEEPGRAM_API_KEY}"},
        )
        await websocket.send_text(
            json.dumps(
                {
                    "type": "ready",
                    "language": LANGUAGE_MAP.get(lang, lang),
                    "sample_rate": TRANSCRIBE_SAMPLE_RATE,
                    "provider": "deepgram",
                },
                ensure_ascii=False,
            )
        )
        await asyncio.gather(pump_audio(upstream), pump_transcripts(upstream))
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        logger.exception("deepgram transcribe failed")
        if websocket.client_state == WebSocketState.CONNECTED:
            try:
                await websocket.send_text(
                    json.dumps(
                        {"type": "error", "message": f"Deepgram STT 连接失败：{exc}"},
                        ensure_ascii=False,
                    )
                )
            except RuntimeError:
                pass
    finally:
        client_gone.set()
        reader.cancel()
        await asyncio.gather(reader, return_exceptions=True)
        await _close_websocket(websocket)
