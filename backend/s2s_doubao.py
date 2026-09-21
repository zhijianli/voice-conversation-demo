"""豆包 Realtime Dialogue WebSocket 代理。"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import uuid
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect

from doubao_protocol import build_audio_request, build_full_request, parse_response
from prompts import get_instructions
from s2s_common import b64, connect_upstream_ws, float32_pcm_to_int16, send_error, send_event, unb64

logger = logging.getLogger(__name__)

DOUBAO_APP_ID = os.getenv("DOUBAO_APP_ID", "")
DOUBAO_ACCESS_KEY = os.getenv("DOUBAO_ACCESS_KEY", "")
DOUBAO_RESOURCE_ID = os.getenv("DOUBAO_RESOURCE_ID", "volc.speech.dialog")
DOUBAO_APP_KEY = os.getenv("DOUBAO_APP_KEY", "PlgvMymc7f3tQnJ6")
DOUBAO_BASE_URL = os.getenv(
    "DOUBAO_BASE_URL",
    "wss://openspeech.bytedance.com/api/v3/realtime/dialogue",
)
DOUBAO_SPEAKER = os.getenv("DOUBAO_SPEAKER", "zh_female_vv_jupiter_bigtts")
DOUBAO_BOT_NAME = os.getenv("DOUBAO_BOT_NAME", "豆包")


def doubao_config() -> dict[str, Any]:
    return {
        "configured": bool(DOUBAO_APP_ID and DOUBAO_ACCESS_KEY),
        "speaker": DOUBAO_SPEAKER,
        "base_url": DOUBAO_BASE_URL,
    }


def _connect_headers() -> dict[str, str]:
    return {
        "X-Api-App-ID": DOUBAO_APP_ID,
        "X-Api-Access-Key": DOUBAO_ACCESS_KEY,
        "X-Api-Resource-Id": DOUBAO_RESOURCE_ID,
        "X-Api-App-Key": DOUBAO_APP_KEY,
        "X-Api-Connect-Id": str(uuid.uuid4()),
    }


def _start_session_payload(*, instructions: str) -> dict[str, Any]:
    return {
        "tts": {
            "speaker": DOUBAO_SPEAKER,
            "audio_config": {
                "channel": 1,
                "format": "pcm",
                "sample_rate": 24000,
            },
        },
        "dialog": {
            "bot_name": DOUBAO_BOT_NAME,
            "system_role": instructions,
            "speaking_style": "你的说话风格简洁明了，语速适中，语调自然，适合语音对话。",
            "extra": {"strict_audit": False},
        },
    }


class DoubaoAdapter:
    EVENT_START_CONNECTION = 1
    EVENT_FINISH_CONNECTION = 2
    EVENT_START_SESSION = 100
    EVENT_FINISH_SESSION = 102
    EVENT_TASK_REQUEST = 200

    EVENT_CONNECTION_STARTED = 50
    EVENT_SESSION_STARTED = 150
    EVENT_TTS_RESPONSE = 352
    EVENT_ASR_INFO = 450
    EVENT_ASR_RESPONSE = 451
    EVENT_ASR_ENDED = 459
    EVENT_CHAT_RESPONSE = 550
    EVENT_CHAT_ENDED = 559
    EVENT_SESSION_FAILED = 153
    EVENT_CONNECTION_FAILED = 51

    def __init__(self, session_id: str) -> None:
        self.session_id = session_id
        self.started = False
        self.user_speech_active = False
        self.user_pending = False
        self.user_transcript = ""
        self.assistant_transcript = ""
        self.response_active = False

    async def start(self, upstream, *, instructions: str) -> None:
        await upstream.send(build_full_request(self.EVENT_START_CONNECTION, {}))
        response = parse_response(await upstream.recv())
        if response.get("message_type") == "SERVER_ERROR":
            raise RuntimeError(str(response.get("payload_msg")))

        await upstream.send(
            build_full_request(
                self.EVENT_START_SESSION,
                _start_session_payload(instructions=instructions),
                session_id=self.session_id,
            )
        )
        for _ in range(5):
            response = parse_response(await upstream.recv())
            if response.get("message_type") == "SERVER_ERROR":
                raise RuntimeError(str(response.get("payload_msg")))
            if response.get("event") == self.EVENT_SESSION_FAILED:
                raise RuntimeError(str(response.get("payload_msg")))
            if response.get("event") == self.EVENT_SESSION_STARTED:
                self.started = True
                return
        raise RuntimeError("豆包会话启动超时")

    async def send_audio(self, upstream, pcm16: bytes) -> None:
        if not self.started:
            return
        await upstream.send(
            build_audio_request(
                self.EVENT_TASK_REQUEST,
                pcm16,
                session_id=self.session_id,
            )
        )

    async def finish(self, upstream) -> None:
        if not self.started:
            return
        await upstream.send(
            build_full_request(self.EVENT_FINISH_SESSION, {}, session_id=self.session_id)
        )
        await upstream.send(build_full_request(self.EVENT_FINISH_CONNECTION, {}))
        try:
            await upstream.recv()
        except Exception:
            pass

    async def handle_server(self, response: dict[str, Any], client_ws: WebSocket) -> None:
        event = response.get("event")
        payload = response.get("payload_msg")
        message_type = response.get("message_type")

        if message_type == "SERVER_ERROR":
            await send_event(
                client_ws,
                {"type": "error", "error": {"message": str(payload)}},
            )
            return

        if event == self.EVENT_ASR_INFO:
            if not self.user_speech_active:
                self.user_speech_active = True
                self.user_pending = True
                self.user_transcript = ""
                await send_event(client_ws, {"type": "input_audio_buffer.speech_started"})
            return

        if event == self.EVENT_ASR_RESPONSE and isinstance(payload, dict):
            results = payload.get("results") or []
            if not results:
                return
            text = str(results[-1].get("text") or "").strip()
            is_interim = bool(results[-1].get("is_interim"))
            if text:
                self.user_transcript = text
            if not is_interim and text:
                await send_event(
                    client_ws,
                    {
                        "type": "conversation.item.input_audio_transcription.completed",
                        "transcript": text,
                    },
                )
            return

        if event == self.EVENT_ASR_ENDED:
            await send_event(client_ws, {"type": "input_audio_buffer.speech_stopped"})
            self.user_pending = False
            self.user_speech_active = False
            return

        if event == self.EVENT_CHAT_RESPONSE and isinstance(payload, dict):
            content = str(payload.get("content") or "")
            if not content:
                return
            if not self.response_active:
                self.response_active = True
                self.assistant_transcript = ""
                await send_event(client_ws, {"type": "response.created"})
            delta = content[len(self.assistant_transcript) :]
            self.assistant_transcript = content
            if delta:
                await send_event(
                    client_ws,
                    {"type": "response.output_audio_transcript.delta", "delta": delta},
                )
            return

        if event == self.EVENT_TTS_RESPONSE and isinstance(payload, (bytes, bytearray)):
            if not self.response_active:
                self.response_active = True
                self.assistant_transcript = ""
                await send_event(client_ws, {"type": "response.created"})
            pcm16 = float32_pcm_to_int16(bytes(payload))
            await send_event(
                client_ws,
                {
                    "type": "response.audio.delta",
                    "delta": b64(pcm16),
                    "sample_rate": 24000,
                    "format": "pcm16",
                },
            )
            return

        if event == self.EVENT_CHAT_ENDED:
            if self.assistant_transcript.strip():
                await send_event(
                    client_ws,
                    {
                        "type": "response.output_audio_transcript.done",
                        "transcript": self.assistant_transcript.strip(),
                    },
                )
            await send_event(client_ws, {"type": "response.done"})
            self.response_active = False
            self.assistant_transcript = ""
            return

        if event in {self.EVENT_CONNECTION_FAILED, self.EVENT_SESSION_FAILED}:
            await send_event(
                client_ws,
                {"type": "error", "error": {"message": str(payload)}},
            )


async def handle_doubao_ws(websocket: WebSocket, *, use_langfuse: bool = False) -> None:
    if not DOUBAO_APP_ID or not DOUBAO_ACCESS_KEY:
        await websocket.accept()
        await send_error(
            websocket,
            "DOUBAO_APP_ID / DOUBAO_ACCESS_KEY 未配置，请检查 backend/.env",
        )
        await websocket.close()
        return

    await websocket.accept()
    upstream = None
    session_id = str(uuid.uuid4())
    instructions, _ = get_instructions(use_langfuse=use_langfuse)
    adapter = DoubaoAdapter(session_id)

    async def pump_client() -> None:
        try:
            while True:
                message = await websocket.receive()
                if message["type"] == "websocket.disconnect":
                    break
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
                        await adapter.send_audio(upstream, unb64(audio))
        except WebSocketDisconnect:
            pass
        except Exception:
            logger.exception("doubao client pump failed")

    async def pump_upstream() -> None:
        try:
            async for message in upstream:
                if not isinstance(message, (bytes, bytearray)):
                    continue
                response = parse_response(bytes(message))
                await adapter.handle_server(response, websocket)
        except Exception:
            logger.exception("doubao upstream pump failed")

    try:
        upstream = await connect_upstream_ws(
            DOUBAO_BASE_URL,
            headers=_connect_headers(),
        )
        await adapter.start(upstream, instructions=instructions)

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
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        logger.exception("doubao s2s failed")
        try:
            await send_error(websocket, str(exc))
        except Exception:
            pass
    finally:
        if upstream is not None:
            try:
                await adapter.finish(upstream)
            except Exception:
                pass
            await upstream.close()
