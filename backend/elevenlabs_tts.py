from __future__ import annotations

import os
from typing import Any

import httpx
from dotenv import load_dotenv

load_dotenv(override=True)

ELEVENLABS_API_KEY = os.getenv("ELEVENLABS_API_KEY", "").strip()
ELEVENLABS_VOICE_ID = os.getenv("ELEVENLABS_VOICE_ID", "pFZP5JQG7iQjIQuC4Bku")
ELEVENLABS_MODEL_ID = os.getenv("ELEVENLABS_MODEL_ID", "eleven_v3_conversational")
ELEVENLABS_BASE_URL = os.getenv("ELEVENLABS_BASE_URL", "https://api.elevenlabs.io").rstrip("/")
ELEVENLABS_TIMEOUT_SECONDS = 30.0
_LANGUAGE_CODE_MODELS = {
    "eleven_flash_v2",
    "eleven_flash_v2_5",
    "eleven_turbo_v2",
    "eleven_turbo_v2_5",
}


def elevenlabs_config() -> dict[str, Any]:
    return {
        "elevenlabs_voice": ELEVENLABS_VOICE_ID,
        "elevenlabs_model": ELEVENLABS_MODEL_ID,
        "elevenlabs_configured": bool(ELEVENLABS_API_KEY),
    }


def _error_detail(response: httpx.Response) -> str:
    try:
        payload = response.json()
    except ValueError:
        return response.text or response.reason_phrase

    detail = payload.get("detail", payload.get("message", payload))
    if isinstance(detail, dict):
        return str(detail.get("message") or detail)
    return str(detail)


def synthesize_elevenlabs(
    text: str,
    profile: dict[str, str] | None = None,
) -> tuple[bytes, str]:
    cleaned = (text or "").strip()
    if not cleaned:
        raise ValueError("TTS 文本为空")
    if not ELEVENLABS_API_KEY:
        raise RuntimeError("ELEVENLABS_API_KEY 未配置，请检查 backend/.env")

    voice_id = (profile or {}).get("elevenlabs_voice") or ELEVENLABS_VOICE_ID
    model_id = (profile or {}).get("elevenlabs_model") or ELEVENLABS_MODEL_ID
    language_code = (profile or {}).get("elevenlabs_language") or "zh"
    url = f"{ELEVENLABS_BASE_URL}/v1/text-to-speech/{voice_id}"
    body: dict[str, Any] = {
        "text": cleaned,
        "model_id": model_id,
        "voice_settings": {
            "stability": 0.5,
            "similarity_boost": 0.75,
            "speed": 1.0,
        },
    }
    if model_id in _LANGUAGE_CODE_MODELS:
        body["language_code"] = language_code

    try:
        response = httpx.post(
            url,
            params={"output_format": "mp3_44100_128"},
            headers={
                "xi-api-key": ELEVENLABS_API_KEY,
                "Accept": "audio/mpeg",
                "Content-Type": "application/json",
            },
            json=body,
            timeout=ELEVENLABS_TIMEOUT_SECONDS,
        )
    except httpx.HTTPError as exc:
        raise RuntimeError(f"ElevenLabs 请求失败：{exc}") from exc

    if response.status_code >= 400:
        raise RuntimeError(f"ElevenLabs 合成失败：{_error_detail(response)}")
    audio = response.content
    if not audio:
        raise RuntimeError("ElevenLabs 未返回音频")
    return audio, "audio/mpeg"
