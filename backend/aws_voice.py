from __future__ import annotations

import asyncio
import io
import json
import logging
import os
import wave
from typing import Any

import boto3
from amazon_transcribe.client import TranscribeStreamingClient
from amazon_transcribe.handlers import TranscriptResultStreamHandler
from amazon_transcribe.model import TranscriptEvent
from botocore.exceptions import BotoCoreError, ClientError
from dotenv import load_dotenv
from fastapi import WebSocket, WebSocketDisconnect
from starlette.websockets import WebSocketState

load_dotenv(override=True)

logger = logging.getLogger(__name__)

AWS_REGION = os.getenv("AWS_REGION", "us-east-2")
TRANSCRIBE_LANGUAGE_CODE = os.getenv("TRANSCRIBE_LANGUAGE_CODE", "en-US")
TRANSCRIBE_SAMPLE_RATE = int(os.getenv("TRANSCRIBE_SAMPLE_RATE", "16000"))
POLLY_VOICE_ID = os.getenv("POLLY_VOICE_ID", "Ruth")
POLLY_ENGINE = os.getenv("POLLY_ENGINE", "generative")
POLLY_LANGUAGE_CODE = os.getenv("POLLY_LANGUAGE_CODE", "en-US")
POLLY_MAX_CHARS = 2500
# Neural MP3/OGG allow 24000; PCM only allows 8000 or 16000.
POLLY_PCM_SAMPLE_RATE = "16000"
POLLY_MP3_SAMPLE_RATE = "24000"

_polly_client = None


def aws_voice_config() -> dict[str, Any]:
    return {
        "region": AWS_REGION,
        "transcribe_language": TRANSCRIBE_LANGUAGE_CODE,
        "transcribe_sample_rate": TRANSCRIBE_SAMPLE_RATE,
        "polly_voice": POLLY_VOICE_ID,
        "polly_engine": POLLY_ENGINE,
        "polly_language": POLLY_LANGUAGE_CODE,
        "credentials_configured": bool(
            os.getenv("AWS_ACCESS_KEY_ID") or os.getenv("AWS_PROFILE")
        ),
    }


def get_polly_client():
    global _polly_client
    if _polly_client is None:
        _polly_client = boto3.client("polly", region_name=AWS_REGION)
    return _polly_client


def pcm_to_wav(pcm: bytes, sample_rate: int = 24000) -> bytes:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(pcm)
    return buffer.getvalue()


def split_for_polly(text: str, max_chars: int = POLLY_MAX_CHARS) -> list[str]:
    cleaned = (text or "").strip()
    if not cleaned:
        return []
    if len(cleaned) <= max_chars:
        return [cleaned]

    chunks: list[str] = []
    current = ""
    for char in cleaned:
        current += char
        if len(current) >= max_chars and char in "。！？!?；;\n，,、 ":
            piece = current.strip()
            if piece:
                chunks.append(piece)
            current = ""
    leftover = current.strip()
    if leftover:
        chunks.append(leftover)
    return chunks or [cleaned[:max_chars]]


def _polly_bytes(client, text: str, output_format: str, sample_rate: str) -> bytes:
    try:
        response = client.synthesize_speech(
            Engine=POLLY_ENGINE,
            LanguageCode=POLLY_LANGUAGE_CODE,
            OutputFormat=output_format,
            SampleRate=sample_rate,
            Text=text,
            TextType="text",
            VoiceId=POLLY_VOICE_ID,
        )
    except (BotoCoreError, ClientError) as exc:
        raise RuntimeError(f"Amazon Polly 合成失败：{exc}") from exc

    stream = response.get("AudioStream")
    if stream is None:
        raise RuntimeError("Amazon Polly 未返回音频流")
    return stream.read()


def synthesize_speech(text: str) -> tuple[bytes, str]:
    """Return (audio_bytes, media_type). One MP3 clip for a normal-length reply."""
    cleaned = (text or "").strip()
    if not cleaned:
        raise ValueError("TTS 文本为空")

    pieces = split_for_polly(cleaned)
    client = get_polly_client()

    if len(pieces) == 1:
        return (
            _polly_bytes(client, pieces[0], "mp3", POLLY_MP3_SAMPLE_RATE),
            "audio/mpeg",
        )

    pcm = bytearray()
    for piece in pieces:
        pcm.extend(_polly_bytes(client, piece, "pcm", POLLY_PCM_SAMPLE_RATE))
    return pcm_to_wav(bytes(pcm), sample_rate=int(POLLY_PCM_SAMPLE_RATE)), "audio/wav"


class _WebsocketTranscriptHandler(TranscriptResultStreamHandler):
    def __init__(self, output_stream, websocket: WebSocket):
        super().__init__(output_stream)
        self.websocket = websocket

    async def handle_transcript_event(self, transcript_event: TranscriptEvent):
        transcript = getattr(transcript_event, "transcript", None)
        results = getattr(transcript, "results", None) or []
        for result in results:
            alternatives = getattr(result, "alternatives", None) or []
            if not alternatives:
                continue
            text = (getattr(alternatives[0], "transcript", None) or "").strip()
            if not text:
                continue
            is_partial = bool(getattr(result, "is_partial", True))
            payload = {
                "type": "partial" if is_partial else "final",
                "text": text,
            }
            if self.websocket.client_state != WebSocketState.CONNECTED:
                return
            await self.websocket.send_text(json.dumps(payload, ensure_ascii=False))


async def transcribe_websocket(websocket: WebSocket) -> None:
    await websocket.accept()
    audio_queue: asyncio.Queue[bytes | None] = asyncio.Queue(maxsize=40)
    stream = None

    async def read_client():
        try:
            while True:
                message = await websocket.receive()
                message_type = message.get("type")
                if message_type == "websocket.disconnect":
                    break
                if "bytes" in message and message["bytes"] is not None:
                    chunk = message["bytes"]
                    if chunk:
                        await audio_queue.put(chunk)
                elif "text" in message and message["text"]:
                    try:
                        control = json.loads(message["text"])
                    except json.JSONDecodeError:
                        continue
                    if control.get("type") in {"stop", "close"}:
                        break
        except WebSocketDisconnect:
            pass
        finally:
            await audio_queue.put(None)

    async def write_audio():
        assert stream is not None
        try:
            while True:
                chunk = await audio_queue.get()
                if chunk is None:
                    break
                await stream.input_stream.send_audio_event(audio_chunk=chunk)
        finally:
            try:
                await stream.input_stream.end_stream()
            except Exception:
                logger.debug("end transcribe stream ignored", exc_info=True)

    try:
        client = TranscribeStreamingClient(region=AWS_REGION)
        stream = await client.start_stream_transcription(
            language_code=TRANSCRIBE_LANGUAGE_CODE,
            media_sample_rate_hz=TRANSCRIBE_SAMPLE_RATE,
            media_encoding="pcm",
            enable_partial_results_stabilization=True,
            partial_results_stability="medium",
        )
        await websocket.send_text(
            json.dumps(
                {
                    "type": "ready",
                    "language": TRANSCRIBE_LANGUAGE_CODE,
                    "sample_rate": TRANSCRIBE_SAMPLE_RATE,
                }
            )
        )
        handler = _WebsocketTranscriptHandler(stream.output_stream, websocket)
        reader = asyncio.create_task(read_client())
        writer = asyncio.create_task(write_audio())
        handler_task = asyncio.create_task(handler.handle_events())
        try:
            await handler_task
        finally:
            await audio_queue.put(None)
            if websocket.client_state == WebSocketState.CONNECTED:
                await websocket.close()
            await asyncio.gather(reader, writer, return_exceptions=True)
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        logger.exception("Amazon Transcribe streaming failed")
        if websocket.client_state == WebSocketState.CONNECTED:
            await websocket.send_text(
                json.dumps(
                    {
                        "type": "error",
                        "message": f"Amazon Transcribe 连接失败：{exc}",
                    },
                    ensure_ascii=False,
                )
            )
    finally:
        if websocket.client_state == WebSocketState.CONNECTED:
            await websocket.close()
