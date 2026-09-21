"""端到端语音 WebSocket 代理的公共工具。"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import logging
import struct
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect

logger = logging.getLogger(__name__)


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def unb64(text: str) -> bytes:
    return base64.b64decode(text)


def float32_pcm_to_int16(raw: bytes) -> bytes:
    if not raw:
        return b""
    count = len(raw) // 4
    floats = struct.unpack(f"<{count}f", raw[: count * 4])
    ints = []
    for sample in floats:
        clipped = max(-1.0, min(1.0, sample))
        ints.append(int(clipped * 32767))
    return struct.pack(f"<{count}h", *ints)


async def send_event(ws: WebSocket, event: dict[str, Any]) -> None:
    await ws.send_text(json.dumps(event, ensure_ascii=False))


async def send_error(ws: WebSocket, message: str) -> None:
    await send_event(ws, {"type": "error", "error": {"message": message}})


async def relay_text_websocket(
    client_ws: WebSocket,
    upstream_ws,
    *,
    client_to_upstream,
    upstream_to_client,
) -> None:
    """双向转发 JSON WebSocket，两端都用 send/receive str。"""

    async def pump_client() -> None:
        try:
            while True:
                message = await client_ws.receive()
                if message["type"] == "websocket.disconnect":
                    break
                text = message.get("text")
                if text is None:
                    continue
                try:
                    payload = json.loads(text)
                except json.JSONDecodeError:
                    continue
                await client_to_upstream(payload)
        except WebSocketDisconnect:
            pass
        except Exception:
            logger.exception("s2s client pump failed")

    async def pump_upstream() -> None:
        try:
            async for message in upstream_ws:
                if isinstance(message, bytes):
                    continue
                try:
                    payload = json.loads(message)
                except json.JSONDecodeError:
                    continue
                await upstream_to_client(payload)
        except Exception:
            logger.exception("s2s upstream pump failed")

    tasks = [
        asyncio.create_task(pump_client()),
        asyncio.create_task(pump_upstream()),
    ]
    done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    for task in pending:
        task.cancel()
    for task in done:
        with contextlib.suppress(asyncio.CancelledError):
            await task


def ws_connect_headers(api_key: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {api_key}"}


async def connect_upstream_ws(url: str, *, headers: dict[str, str], subprotocols=None):
    import websockets

    kwargs = {"ping_interval": 20, "ping_timeout": 20}
    try:
        return await websockets.connect(
            url,
            additional_headers=headers,
            subprotocols=subprotocols,
            **kwargs,
        )
    except TypeError:
        return await websockets.connect(
            url,
            extra_headers=headers,
            subprotocols=subprotocols,
            **kwargs,
        )
