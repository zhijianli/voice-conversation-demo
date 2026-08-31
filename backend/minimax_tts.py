from __future__ import annotations

import asyncio
import json
import os
import time
from collections.abc import AsyncIterator
from typing import Any

import httpx
from dotenv import load_dotenv

load_dotenv(override=True)

MINIMAX_API_KEY = os.getenv("MINIMAX_API_KEY", "").strip()
MINIMAX_GROUP_ID = os.getenv("MINIMAX_GROUP_ID", "").strip()
MINIMAX_PROVIDER = os.getenv("MINIMAX_PROVIDER", "official").strip().lower()
MINIMAX_VOICE_ID = os.getenv(
    "MINIMAX_VOICE_ID", "Chinese (Mandarin)_IntellectualGirl"
).strip().strip('"')
MINIMAX_VOICE_CHOICES = (
    "Chinese (Mandarin)_Wise_Women",
    "Chinese (Mandarin)_Warm_Bestie",
    "Chinese (Mandarin)_Warm_Girl",
    "Chinese (Mandarin)_IntellectualGirl",
    "Chinese (Mandarin)_Laid_BackGirl",
)
MINIMAX_MODEL_ID = os.getenv(
    "MINIMAX_MODEL_ID",
    "speech-2.6-turbo",
)
MINIMAX_EMOTION = os.getenv("MINIMAX_EMOTION", "calm").strip() or "calm"
MINIMAX_SPEED = float(os.getenv("MINIMAX_SPEED", "0.95"))
MINIMAX_BASE_URL = os.getenv(
    "MINIMAX_BASE_URL",
    "https://api.minimaxi.com",
).rstrip("/")
MINIMAX_TIMEOUT_SECONDS = 45.0
MINIMAX_PCM_SAMPLE_RATE = 16000
MINIMAX_KEEPALIVE_SECONDS = 30.0
_GMI_POLL_INTERVAL_SECONDS = 0.4
_WARMUP_TEXT = "嗯。"

_async_client: httpx.AsyncClient | None = None
_client_lock: asyncio.Lock | None = None
_keep_alive_task: asyncio.Task[None] | None = None
_warmup_ms: float | None = None
_last_warmup_at = 0.0


def resolve_minimax_voice(voice_id: str | None = None) -> str:
    cleaned = (voice_id or "").strip().strip('"')
    if cleaned in MINIMAX_VOICE_CHOICES:
        return cleaned
    return MINIMAX_VOICE_ID


def minimax_config() -> dict[str, Any]:
    return {
        "minimax_provider": MINIMAX_PROVIDER,
        "minimax_voice": MINIMAX_VOICE_ID,
        "minimax_model": MINIMAX_MODEL_ID,
        "minimax_emotion": MINIMAX_EMOTION,
        "minimax_speed": MINIMAX_SPEED,
        "minimax_stream": MINIMAX_PROVIDER != "gmi",
        "minimax_configured": bool(MINIMAX_API_KEY),
        "minimax_warmed": _warmup_ms is not None,
        "minimax_warmup_ms": _warmup_ms,
    }


def _status_error(payload: dict[str, Any]) -> str | None:
    base = payload.get("base_resp") or {}
    code = base.get("status_code", 0)
    if code in (0, None):
        return None
    message = base.get("status_msg") or payload.get("message") or "未知错误"
    return f"{code} {message}"


def _auth_headers() -> dict[str, str]:
    return {
        "Authorization": f"Bearer {MINIMAX_API_KEY}",
        "Content-Type": "application/json",
    }


def _get_client_lock() -> asyncio.Lock:
    global _client_lock
    if _client_lock is None:
        _client_lock = asyncio.Lock()
    return _client_lock


def _new_async_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(
        timeout=httpx.Timeout(MINIMAX_TIMEOUT_SECONDS, connect=8.0),
        trust_env=False,
        limits=httpx.Limits(
            max_keepalive_connections=8,
            max_connections=16,
            keepalive_expiry=90.0,
        ),
    )


async def get_minimax_client() -> httpx.AsyncClient:
    global _async_client
    client = _async_client
    if client is not None and not client.is_closed:
        return client
    async with _get_client_lock():
        if _async_client is None or _async_client.is_closed:
            _async_client = _new_async_client()
        return _async_client


async def reset_minimax_client() -> None:
    global _async_client
    async with _get_client_lock():
        client = _async_client
        _async_client = None
    if client is not None and not client.is_closed:
        await client.aclose()


async def _keep_alive_loop() -> None:
    url = f"{MINIMAX_BASE_URL}/v1/get_voice"
    while True:
        await asyncio.sleep(MINIMAX_KEEPALIVE_SECONDS)
        try:
            client = await get_minimax_client()
            await client.post(
                url,
                headers=_auth_headers(),
                json={"voice_type": "system"},
                timeout=8.0,
            )
        except httpx.TransportError:
            try:
                await reset_minimax_client()
            except Exception:
                pass
        except Exception:
            pass


async def warmup_minimax(*, force: bool = False) -> None:
    global _warmup_ms, _last_warmup_at, _keep_alive_task
    if not MINIMAX_API_KEY or MINIMAX_PROVIDER == "gmi":
        return
    now = time.monotonic()
    if not force and _last_warmup_at and now - _last_warmup_at < 20:
        return
    _last_warmup_at = now
    started = time.monotonic()
    await get_minimax_client()
    if _keep_alive_task is None or _keep_alive_task.done():
        _keep_alive_task = asyncio.create_task(_keep_alive_loop())
    first_ms: float | None = None
    try:
        t0 = time.monotonic()
        async for chunk in iter_minimax_pcm(_WARMUP_TEXT):
            if chunk:
                first_ms = (time.monotonic() - t0) * 1000
                break
        _warmup_ms = (time.monotonic() - started) * 1000
        print(
            f"MiniMax warmup first_audio={first_ms:.0f}ms total={_warmup_ms:.0f}ms"
            if first_ms is not None
            else f"MiniMax warmup finished in {_warmup_ms:.0f}ms without audio",
            flush=True,
        )
    except Exception as exc:
        print(f"MiniMax warmup failed: {exc}", flush=True)


async def close_minimax_runtime() -> None:
    global _keep_alive_task
    task = _keep_alive_task
    _keep_alive_task = None
    if task is not None:
        task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):
            pass
    await reset_minimax_client()


def _pcm_from_hex(audio_hex: str) -> bytes:
    cleaned = (audio_hex or "").strip()
    if len(cleaned) < 2 or len(cleaned) % 2:
        return b""
    try:
        return bytes.fromhex(cleaned)
    except ValueError:
        return b""


def _audio_hex_from_payload(payload: dict[str, Any]) -> str:
    data = payload.get("data")
    if isinstance(data, dict):
        value = str(data.get("audio") or "").strip()
        if value:
            return value
    return str(payload.get("audio") or "").strip()


def _is_final_payload(payload: dict[str, Any]) -> bool:
    if payload.get("extra_info"):
        return True
    data = payload.get("data")
    return isinstance(data, dict) and data.get("status") == 2


def _media_url(payload: dict[str, Any]) -> str | None:
    outcome = payload.get("outcome") or {}
    for key in ("audio_url", "url"):
        value = str(outcome.get(key) or payload.get(key) or "").strip()
        if value:
            return value
    urls = outcome.get("media_urls") or []
    if urls and isinstance(urls[0], dict):
        return str(urls[0].get("url") or "").strip() or None
    if urls:
        return str(urls[0]).strip() or None
    return None


def _download_audio(url: str) -> bytes:
    try:
        response = httpx.get(url, timeout=MINIMAX_TIMEOUT_SECONDS, follow_redirects=True)
    except httpx.HTTPError as exc:
        raise RuntimeError(f"MiniMax 音频下载失败：{exc}") from exc
    if response.status_code >= 400 or not response.content:
        raise RuntimeError(f"MiniMax 音频下载失败：{response.status_code}")
    return response.content


def _synthesize_gmi(text: str, profile: dict[str, str] | None) -> tuple[bytes, str]:
    voice_id = (profile or {}).get("minimax_voice") or MINIMAX_VOICE_ID
    model_id = (profile or {}).get("minimax_model") or MINIMAX_MODEL_ID
    language_boost = (profile or {}).get("minimax_language") or "Chinese"
    submit_url = f"{MINIMAX_BASE_URL}/api/v1/ie/requestqueue/apikey/requests"
    body = {
        "model": model_id,
        "payload": {
            "text": text,
            "voice_id": voice_id,
            "speed": str(MINIMAX_SPEED),
            "vol": "1",
            "pitch": "0",
            "emotion": MINIMAX_EMOTION,
            "language_boost": language_boost,
            "format": "mp3",
            "audio_sample_rate": "32000",
            "bitrate": "128000",
            "channel": "1",
        },
    }

    try:
        submitted = httpx.post(
            submit_url,
            headers=_auth_headers(),
            json=body,
            timeout=MINIMAX_TIMEOUT_SECONDS,
        )
    except httpx.HTTPError as exc:
        raise RuntimeError(f"MiniMax 请求失败：{exc}") from exc

    try:
        payload = submitted.json()
    except ValueError as exc:
        raise RuntimeError(
            f"MiniMax 合成失败：{submitted.status_code} {submitted.text[:240]}"
        ) from exc

    if submitted.status_code >= 400:
        detail = payload.get("message") or payload.get("error") or submitted.text[:240]
        raise RuntimeError(f"MiniMax 合成失败：{detail}")

    request_id = str(payload.get("request_id") or "").strip()
    deadline = time.monotonic() + MINIMAX_TIMEOUT_SECONDS
    in_progress = {
        "",
        "queued",
        "processing",
        "pending",
        "running",
        "dispatched",
        "submitted",
    }

    while True:
        status = str(payload.get("status") or "").lower()
        audio_url = _media_url(payload)
        if audio_url:
            return _download_audio(audio_url), "audio/mpeg"
        if status in {"failed", "cancelled", "error"}:
            detail = payload.get("error") or payload.get("message") or status
            raise RuntimeError(f"MiniMax 合成失败：{detail}")
        if not request_id or status not in in_progress and status != "success":
            raise RuntimeError(f"MiniMax 未返回音频：{status or 'empty'}")
        if time.monotonic() > deadline:
            raise RuntimeError("MiniMax 合成超时")
        time.sleep(_GMI_POLL_INTERVAL_SECONDS)
        poll_url = f"{submit_url}/{request_id}"
        try:
            polled = httpx.get(
                poll_url,
                headers={"Authorization": f"Bearer {MINIMAX_API_KEY}"},
                timeout=MINIMAX_TIMEOUT_SECONDS,
            )
        except httpx.HTTPError as exc:
            raise RuntimeError(f"MiniMax 查询失败：{exc}") from exc
        try:
            payload = polled.json()
        except ValueError as exc:
            raise RuntimeError(
                f"MiniMax 查询失败：{polled.status_code} {polled.text[:240]}"
            ) from exc
        if polled.status_code >= 400:
            detail = payload.get("message") or payload.get("error") or polled.text[:240]
            raise RuntimeError(f"MiniMax 查询失败：{detail}")


def _synthesize_official(text: str, profile: dict[str, str] | None) -> tuple[bytes, str]:
    voice_id = (profile or {}).get("minimax_voice") or MINIMAX_VOICE_ID
    model_id = (profile or {}).get("minimax_model") or MINIMAX_MODEL_ID
    language_boost = (profile or {}).get("minimax_language") or "Chinese"
    url = f"{MINIMAX_BASE_URL}/v1/t2a_v2"
    params = {"GroupId": MINIMAX_GROUP_ID} if MINIMAX_GROUP_ID else None
    body = {
        "model": model_id,
        "text": text,
        "stream": False,
        "language_boost": language_boost,
        "output_format": "url",
        "voice_setting": {
            "voice_id": voice_id,
            "speed": MINIMAX_SPEED,
            "vol": 1.0,
            "pitch": 0,
            "emotion": MINIMAX_EMOTION,
        },
        "audio_setting": {
            "sample_rate": 32000,
            "bitrate": 128000,
            "format": "mp3",
            "channel": 1,
        },
    }

    try:
        response = httpx.post(
            url,
            params=params,
            headers=_auth_headers(),
            json=body,
            timeout=MINIMAX_TIMEOUT_SECONDS,
        )
    except httpx.HTTPError as exc:
        raise RuntimeError(f"MiniMax 请求失败：{exc}") from exc

    try:
        payload = response.json()
    except ValueError as exc:
        raise RuntimeError(
            f"MiniMax 合成失败：{response.status_code} {response.text[:240]}"
        ) from exc

    api_error = _status_error(payload)
    if response.status_code >= 400 or api_error:
        raise RuntimeError(f"MiniMax 合成失败：{api_error or response.text[:240]}")

    data = payload.get("data") or {}
    audio_url = str(data.get("audio") or "").strip()
    if audio_url.startswith("http"):
        return _download_audio(audio_url), "audio/mpeg"
    audio_hex = audio_url
    if not audio_hex:
        raise RuntimeError("MiniMax 未返回音频")
    try:
        audio = bytes.fromhex(audio_hex)
    except ValueError as exc:
        raise RuntimeError("MiniMax 返回的音频无法解码") from exc
    if not audio:
        raise RuntimeError("MiniMax 未返回音频")
    return audio, "audio/mpeg"


def _synthesize_pcm_once(
    text: str,
    profile: dict[str, str] | None = None,
) -> bytes:
    voice_id = (profile or {}).get("minimax_voice") or MINIMAX_VOICE_ID
    model_id = (profile or {}).get("minimax_model") or MINIMAX_MODEL_ID
    language_boost = (profile or {}).get("minimax_language") or "Chinese"
    url = f"{MINIMAX_BASE_URL}/v1/t2a_v2"
    params = {"GroupId": MINIMAX_GROUP_ID} if MINIMAX_GROUP_ID else None
    body = {
        "model": model_id,
        "text": text,
        "stream": False,
        "language_boost": language_boost,
        "output_format": "hex",
        "voice_setting": {
            "voice_id": voice_id,
            "speed": MINIMAX_SPEED,
            "vol": 1.0,
            "pitch": 0,
            "emotion": MINIMAX_EMOTION,
        },
        "audio_setting": {
            "sample_rate": MINIMAX_PCM_SAMPLE_RATE,
            "format": "pcm",
            "channel": 1,
        },
    }
    try:
        response = httpx.post(
            url,
            params=params,
            headers=_auth_headers(),
            json=body,
            timeout=MINIMAX_TIMEOUT_SECONDS,
        )
    except httpx.HTTPError:
        return b""
    try:
        payload = response.json()
    except ValueError:
        return b""
    if response.status_code >= 400 or _status_error(payload):
        return b""
    audio_hex = str(((payload.get("data") or {}).get("audio") or "")).strip()
    if len(audio_hex) < 2 or len(audio_hex) % 2:
        return b""
    try:
        return bytes.fromhex(audio_hex)
    except ValueError:
        return b""


async def iter_minimax_pcm(
    text: str,
    profile: dict[str, str] | None = None,
) -> AsyncIterator[bytes]:
    cleaned = (text or "").strip()
    if not cleaned:
        raise ValueError("TTS 文本为空")
    if not MINIMAX_API_KEY:
        raise RuntimeError("MINIMAX_API_KEY 未配置，请检查 backend/.env")
    if MINIMAX_PROVIDER == "gmi":
        raise RuntimeError("GMI MiniMax 不支持流式 PCM")

    voice_id = (profile or {}).get("minimax_voice") or MINIMAX_VOICE_ID
    model_id = (profile or {}).get("minimax_model") or MINIMAX_MODEL_ID
    language_boost = (profile or {}).get("minimax_language") or "Chinese"
    url = f"{MINIMAX_BASE_URL}/v1/t2a_v2"
    params = {"GroupId": MINIMAX_GROUP_ID} if MINIMAX_GROUP_ID else None
    body = {
        "model": model_id,
        "text": cleaned,
        "stream": True,
        "language_boost": language_boost,
        "stream_options": {"exclude_aggregated_audio": True},
        "voice_setting": {
            "voice_id": voice_id,
            "speed": MINIMAX_SPEED,
            "vol": 1.0,
            "pitch": 0,
            "emotion": MINIMAX_EMOTION,
        },
        "audio_setting": {
            "sample_rate": MINIMAX_PCM_SAMPLE_RATE,
            "format": "pcm",
            "channel": 1,
        },
    }

    got_audio = False
    last_transport: Exception | None = None
    for attempt in range(2):
        client = await get_minimax_client()
        try:
            async for chunk in _stream_minimax_pcm(client, url, params, body):
                got_audio = True
                yield chunk
            last_transport = None
            break
        except httpx.TransportError as exc:
            last_transport = exc
            await reset_minimax_client()
            if attempt == 0:
                continue
            raise RuntimeError(f"MiniMax 请求失败：{exc}") from exc
    if not got_audio:
        fallback = await asyncio.to_thread(_synthesize_pcm_once, cleaned, profile)
        if fallback:
            yield fallback
            return
        if last_transport:
            raise RuntimeError(f"MiniMax 请求失败：{last_transport}") from last_transport
        raise RuntimeError("MiniMax 未返回音频")


async def _stream_minimax_pcm(
    client: httpx.AsyncClient,
    url: str,
    params: dict[str, str] | None,
    body: dict[str, Any],
) -> AsyncIterator[bytes]:
    async with client.stream(
        "POST",
        url,
        params=params,
        headers=_auth_headers(),
        json=body,
    ) as response:
        if response.status_code >= 400:
            raw_error = await response.aread()
            try:
                payload = json.loads(raw_error.decode("utf-8", errors="replace"))
            except ValueError as exc:
                raise RuntimeError(
                    f"MiniMax 合成失败：{response.status_code} {raw_error[:240]!r}"
                ) from exc
            api_error = _status_error(payload) if isinstance(payload, dict) else None
            detail = api_error
            if not detail and isinstance(payload, dict):
                detail = payload.get("message")
            if not detail:
                detail = raw_error[:240].decode("utf-8", errors="replace")
            raise RuntimeError(f"MiniMax 合成失败：{detail}")

        buffer = ""
        got_audio = False
        finished = False

        def take_event(raw: str) -> bytes | None:
            nonlocal finished
            if not raw or raw == "[DONE]":
                if raw == "[DONE]":
                    finished = True
                return None
            try:
                payload = json.loads(raw)
            except ValueError:
                return None
            if not isinstance(payload, dict):
                return None
            api_error = _status_error(payload)
            if api_error:
                raise RuntimeError(f"MiniMax 合成失败：{api_error}")
            is_final = _is_final_payload(payload)
            if is_final:
                finished = True
            audio_hex = _audio_hex_from_payload(payload)
            if is_final and got_audio:
                return None
            return _pcm_from_hex(audio_hex) or None

        async for piece in response.aiter_bytes():
            if not piece:
                continue
            buffer += piece.decode("utf-8", errors="replace").replace("\r\n", "\n")
            while "\n" in buffer:
                line, buffer = buffer.split("\n", 1)
                line = line.strip()
                if not line.startswith("data:"):
                    continue
                chunk = take_event(line[5:].strip())
                if chunk:
                    got_audio = True
                    yield chunk
                if finished:
                    break
            if finished:
                break
        if not finished:
            leftover = buffer.strip()
            if leftover.startswith("data:"):
                chunk = take_event(leftover[5:].strip())
                if chunk:
                    yield chunk


def synthesize_minimax(
    text: str,
    profile: dict[str, str] | None = None,
) -> tuple[bytes, str]:
    cleaned = (text or "").strip()
    if not cleaned:
        raise ValueError("TTS 文本为空")
    if not MINIMAX_API_KEY:
        raise RuntimeError("MINIMAX_API_KEY 未配置，请检查 backend/.env")
    if MINIMAX_PROVIDER == "gmi":
        return _synthesize_gmi(cleaned, profile)
    return _synthesize_official(cleaned, profile)
