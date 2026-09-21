"""Gemini Live WebSocket 代理，事件对齐 OpenAI Realtime 子集。"""

from __future__ import annotations

import json
import logging
import os
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect

from prompts import get_instructions
from s2s_common import b64, connect_upstream_ws, send_error, send_event, unb64

logger = logging.getLogger(__name__)

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_MODEL = os.getenv(
    "GEMINI_MODEL",
    "gemini-2.5-flash-native-audio-preview-12-2025",
)
GEMINI_VOICE = os.getenv("GEMINI_VOICE", "Kore")
GEMINI_WS_URL = (
    "wss://generativelanguage.googleapis.com/ws/"
    "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent"
)


def gemini_config() -> dict[str, Any]:
    return {
        "configured": bool(GEMINI_API_KEY),
        "model": GEMINI_MODEL,
        "voice": GEMINI_VOICE,
    }


class GeminiAdapter:
    def __init__(self, *, use_langfuse: bool) -> None:
        instructions, _ = get_instructions(use_langfuse=use_langfuse)
        self.instructions = instructions
        self.user_speech_active = False
        self.user_pending = False
        self.user_transcript = ""
        self.assistant_transcript = ""
        self.response_active = False

    def build_setup(self) -> dict[str, Any]:
        return {
            "setup": {
                "model": f"models/{GEMINI_MODEL}",
                "generationConfig": {
                    "responseModalities": ["AUDIO"],
                    "speechConfig": {
                        "voiceConfig": {
                            "prebuiltVoiceConfig": {"voiceName": GEMINI_VOICE},
                        }
                    },
                },
                "systemInstruction": {
                    "parts": [{"text": self.instructions}],
                },
                "inputAudioTranscription": {},
                "outputAudioTranscription": {},
            }
        }

    async def handle_client(self, payload: dict[str, Any], upstream) -> None:
        event_type = payload.get("type")
        if event_type == "input_audio_buffer.append":
            audio = payload.get("audio")
            if not audio:
                return
            await upstream.send(
                json.dumps(
                    {
                        "realtimeInput": {
                            "audio": {
                                "data": audio,
                                "mimeType": "audio/pcm;rate=16000",
                            }
                        }
                    }
                )
            )
        elif event_type == "response.cancel":
            # Gemini 通过用户新语音自动打断；显式 cancel 暂无等价 API。
            pass

    async def handle_upstream(self, payload: dict[str, Any], client_ws: WebSocket) -> None:
        if payload.get("setupComplete") is not None:
            return

        if "error" in payload:
            message = payload["error"].get("message") or json.dumps(payload["error"], ensure_ascii=False)
            await send_event(client_ws, {"type": "error", "error": {"message": message}})
            return

        server_content = payload.get("serverContent") or {}
        if not server_content:
            return

        if server_content.get("interrupted"):
            self.response_active = False
            self.assistant_transcript = ""
            await send_event(client_ws, {"type": "response.cancelled"})
            return

        input_tx = server_content.get("inputTranscription") or {}
        input_text = str(input_tx.get("text") or "")
        if input_text:
            if not self.user_speech_active:
                self.user_speech_active = True
                self.user_pending = True
                self.user_transcript = ""
                await send_event(client_ws, {"type": "input_audio_buffer.speech_started"})
            if input_text != self.user_transcript:
                self.user_transcript = input_text

        model_turn = server_content.get("modelTurn") or {}
        for part in model_turn.get("parts") or []:
            inline = part.get("inlineData") or {}
            data = inline.get("data")
            mime = str(inline.get("mimeType") or "")
            if data and "audio" in mime:
                if self.user_pending and self.user_transcript.strip():
                    await send_event(
                        client_ws,
                        {
                            "type": "conversation.item.input_audio_transcription.completed",
                            "transcript": self.user_transcript.strip(),
                        },
                    )
                    await send_event(client_ws, {"type": "input_audio_buffer.speech_stopped"})
                    self.user_pending = False
                    self.user_speech_active = False

                if not self.response_active:
                    self.response_active = True
                    self.assistant_transcript = ""
                    await send_event(client_ws, {"type": "response.created"})

                raw = unb64(data)
                await send_event(
                    client_ws,
                    {
                        "type": "response.audio.delta",
                        "delta": b64(raw),
                        "sample_rate": 24000,
                        "format": "pcm16",
                    },
                )

        output_tx = server_content.get("outputTranscription") or {}
        output_text = str(output_tx.get("text") or "")
        if output_text and output_text != self.assistant_transcript:
            delta = output_text[len(self.assistant_transcript) :]
            self.assistant_transcript = output_text
            if delta:
                await send_event(
                    client_ws,
                    {"type": "response.output_audio_transcript.delta", "delta": delta},
                )

        if server_content.get("turnComplete"):
            if self.user_pending and self.user_transcript.strip():
                await send_event(
                    client_ws,
                    {
                        "type": "conversation.item.input_audio_transcription.completed",
                        "transcript": self.user_transcript.strip(),
                    },
                )
                await send_event(client_ws, {"type": "input_audio_buffer.speech_stopped"})
                self.user_pending = False
                self.user_speech_active = False

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


async def handle_gemini_ws(websocket: WebSocket, *, use_langfuse: bool = False) -> None:
    if not GEMINI_API_KEY:
        await websocket.accept()
        await send_error(websocket, "GEMINI_API_KEY 未配置，请检查 backend/.env")
        await websocket.close()
        return

    await websocket.accept()
    upstream = None
    adapter = GeminiAdapter(use_langfuse=use_langfuse)
    try:
        url = f"{GEMINI_WS_URL}?key={GEMINI_API_KEY}"
        upstream = await connect_upstream_ws(url, headers={})
        await upstream.send(json.dumps(adapter.build_setup()))

        async def client_to_upstream(payload: dict[str, Any]) -> None:
            await adapter.handle_client(payload, upstream)

        async def upstream_to_client(payload: dict[str, Any]) -> None:
            await adapter.handle_upstream(payload, websocket)

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
        logger.exception("gemini s2s failed")
        try:
            await send_error(websocket, str(exc))
        except Exception:
            pass
    finally:
        if upstream is not None:
            await upstream.close()
