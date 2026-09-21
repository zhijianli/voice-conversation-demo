"""百炼 Qwen-Audio Realtime WebSocket 代理（OpenAI Realtime 兼容事件）。"""

from __future__ import annotations

import json
import logging
import os
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect

from prompts import get_instructions
from s2s_common import connect_upstream_ws, send_error, send_event, ws_connect_headers

logger = logging.getLogger(__name__)

DASHSCOPE_API_KEY = os.getenv("DASHSCOPE_API_KEY", "")
BAILIAN_BASE_URL = os.getenv(
    "BAILIAN_BASE_URL",
    "wss://dashscope.aliyuncs.com/api-ws/v1/realtime",
)
BAILIAN_MODEL = os.getenv(
    "BAILIAN_MODEL",
    "qwen-audio-3.0-realtime-flash",
)
BAILIAN_VOICE = os.getenv("BAILIAN_VOICE", "longanqian")
BAILIAN_TURN_DETECTION = os.getenv("BAILIAN_TURN_DETECTION", "smart_turn")


def bailian_config() -> dict[str, Any]:
    return {
        "configured": bool(DASHSCOPE_API_KEY),
        "model": BAILIAN_MODEL,
        "voice": BAILIAN_VOICE,
        "turn_detection": BAILIAN_TURN_DETECTION,
        "base_url": BAILIAN_BASE_URL,
    }


def _session_update(*, use_langfuse: bool) -> dict[str, Any]:
    instructions, _ = get_instructions(use_langfuse=use_langfuse)
    turn_detection: dict[str, Any]
    if BAILIAN_TURN_DETECTION == "smart_turn":
        turn_detection = {"type": "smart_turn"}
    elif BAILIAN_TURN_DETECTION == "server_vad":
        turn_detection = {
            "type": "server_vad",
            "threshold": 0.5,
            "silence_duration_ms": 800,
        }
    else:
        turn_detection = {"type": BAILIAN_TURN_DETECTION}

    return {
        "type": "session.update",
        "session": {
            "modalities": ["text", "audio"],
            "voice": BAILIAN_VOICE,
            "instructions": instructions,
            "input_audio_format": "pcm16",
            "output_audio_format": "pcm16",
            "input_audio_transcription": {"model": "gummy-realtime-v1"},
            "turn_detection": turn_detection,
        },
    }


async def handle_bailian_ws(websocket: WebSocket, *, use_langfuse: bool = False) -> None:
    if not DASHSCOPE_API_KEY:
        await websocket.accept()
        await send_error(websocket, "DASHSCOPE_API_KEY 未配置，请检查 backend/.env")
        await websocket.close()
        return

    await websocket.accept()
    upstream = None
    try:
        url = f"{BAILIAN_BASE_URL}?model={BAILIAN_MODEL}"
        headers = {
            **ws_connect_headers(DASHSCOPE_API_KEY),
            "x-dashscope-dataInspection": "disable",
        }
        upstream = await connect_upstream_ws(url, headers=headers)
        await upstream.send(json.dumps(_session_update(use_langfuse=use_langfuse), ensure_ascii=False))

        async def client_to_upstream(payload: dict[str, Any]) -> None:
            event_type = payload.get("type")
            if event_type in {
                "input_audio_buffer.append",
                "input_audio_buffer.commit",
                "input_audio_buffer.clear",
                "response.cancel",
            }:
                await upstream.send(json.dumps(payload, ensure_ascii=False))

        async def upstream_to_client(payload: dict[str, Any]) -> None:
            await send_event(websocket, payload)

        from s2s_common import relay_text_websocket

        await relay_text_websocket(
            websocket,
            upstream,
            client_to_upstream=client_to_upstream,
            upstream_to_client=upstream_to_client,
        )
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        logger.exception("bailian s2s failed")
        try:
            await send_error(websocket, str(exc))
        except Exception:
            pass
    finally:
        if upstream is not None:
            await upstream.close()
