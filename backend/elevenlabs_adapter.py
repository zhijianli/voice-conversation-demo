from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import secrets
import time
import uuid
from pathlib import Path
from typing import Any, AsyncIterator

from dotenv import load_dotenv

load_dotenv(override=True)

from everecho_client import session_pool, stream_free_coach_message

logger = logging.getLogger(__name__)

ELEVENLABS_AGENT_ID = os.getenv("ELEVENLABS_AGENT_ID", "").strip()
ELEVENLABS_API_KEY = os.getenv("ELEVENLABS_API_KEY", "").strip()
ELEVENLABS_BASE_URL = os.getenv("ELEVENLABS_BASE_URL", "https://api.elevenlabs.io").rstrip("/")
ELEVENLABS_CUSTOM_LLM_SECRET = os.getenv("ELEVENLABS_CUSTOM_LLM_SECRET", "").strip()
ELEVENLABS_CUSTOM_LLM_URL = os.getenv("ELEVENLABS_CUSTOM_LLM_URL", "").strip().rstrip("/")
ELEVENLABS_CUSTOM_LLM_MODEL = os.getenv("ELEVENLABS_CUSTOM_LLM_MODEL", "free-coach").strip() or "free-coach"

OPENING_ZH = "我在这里。你现在最想看清楚的是什么？"
OPENING_EN = "I am here. What feels most worth looking at right now?"

_SESSION_TTL_SECONDS = 2 * 60 * 60
_SESSION_MAX = 200
_sessions: dict[str, dict[str, Any]] = {}

# 跨 uvicorn worker：Custom LLM 与前端 EventSource 常落在不同进程，必须用共享存储。
_UI_EVENT_DIR = Path(os.getenv("EL_UI_EVENT_DIR", "/tmp/voice-el-ui-events"))
_SAFE_SESSION_RE = re.compile(r"[^a-zA-Z0-9._-]+")
_UI_EVENT_TTL_SECONDS = 30 * 60


def _ui_event_path(session_id: str) -> Path:
    safe = _SAFE_SESSION_RE.sub("_", (session_id or "").strip())[:128] or "unknown"
    return _UI_EVENT_DIR / f"{safe}.jsonl"


def _prune_ui_event_files(now: float | None = None) -> None:
    now = now if now is not None else time.time()
    try:
        if not _UI_EVENT_DIR.exists():
            return
        for path in _UI_EVENT_DIR.glob("*.jsonl"):
            try:
                age = now - path.stat().st_mtime
            except OSError:
                continue
            if age > _UI_EVENT_TTL_SECONDS:
                path.unlink(missing_ok=True)
    except OSError:
        pass


def publish_ui_event(session_id: str, event: dict[str, Any]) -> None:
    key = (session_id or "").strip()
    if not key:
        return
    payload = {**event, "session_id": key, "ts": time.time()}
    try:
        _UI_EVENT_DIR.mkdir(parents=True, exist_ok=True)
        path = _ui_event_path(key)
        line = json.dumps(payload, ensure_ascii=False) + "\n"
        with path.open("a", encoding="utf-8") as handle:
            handle.write(line)
            handle.flush()
            os.fsync(handle.fileno())
    except OSError:
        logger.exception("publish_ui_event failed session=%s", key[:16])


def _touch_ui_session_active(session_id: str) -> None:
    key = (session_id or "").strip()
    if not key:
        return
    try:
        _UI_EVENT_DIR.mkdir(parents=True, exist_ok=True)
        path = _UI_EVENT_DIR / f"{_SAFE_SESSION_RE.sub('_', key)[:128]}.active"
        path.write_text(
            json.dumps({"session_id": key, "ts": time.time()}, ensure_ascii=False),
            encoding="utf-8",
        )
    except OSError:
        pass


def list_active_ui_sessions(max_age_seconds: float = 120.0) -> list[str]:
    now = time.time()
    found: list[str] = []
    try:
        if not _UI_EVENT_DIR.exists():
            return found
        for path in _UI_EVENT_DIR.glob("*.active"):
            try:
                raw = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            if not isinstance(raw, dict):
                continue
            ts = float(raw.get("ts") or 0)
            sid = str(raw.get("session_id") or "").strip()
            if sid and now - ts <= max_age_seconds:
                found.append(sid)
    except OSError:
        pass
    return found


async def iter_ui_events(session_id: str) -> AsyncIterator[dict[str, Any]]:
    """轮询 jsonl，供 SSE 跨 worker 读取。"""
    key = (session_id or "").strip()
    path = _ui_event_path(key)
    offset = 0
    last_ping = time.time()
    _prune_ui_event_files()
    _touch_ui_session_active(key)
    yield {"type": "ready", "session_id": key}
    while True:
        try:
            _touch_ui_session_active(key)
            if key and path.exists():
                with path.open("r", encoding="utf-8") as handle:
                    handle.seek(offset)
                    chunk = handle.read()
                    offset = handle.tell()
                for raw in chunk.splitlines():
                    line = raw.strip()
                    if not line:
                        continue
                    try:
                        parsed = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if isinstance(parsed, dict):
                        yield parsed
            now = time.time()
            if now - last_ping >= 15:
                yield {"type": "ping", "session_id": key}
                last_ping = now
            await asyncio.sleep(0.04)
        except asyncio.CancelledError:
            raise


def elevenlabs_adapter_config() -> dict[str, Any]:
    return {
        "agent_id": ELEVENLABS_AGENT_ID,
        "agent_configured": bool(ELEVENLABS_AGENT_ID),
        "api_key_configured": bool(ELEVENLABS_API_KEY),
        "custom_llm_secret_configured": bool(ELEVENLABS_CUSTOM_LLM_SECRET),
        "custom_llm_model": ELEVENLABS_CUSTOM_LLM_MODEL,
        "sessions": len(_sessions),
        "ui_event_dir": str(_UI_EVENT_DIR),
    }


DEFAULT_PUBLIC_LLM_URL = "https://api.volohorizon.com/realtime/api/elevenlabs"


# Agent 未开鉴权时用公开 agentId 即可；conversation token 需要 API key 具备 convai_write。
# 默认关掉 signed URL，避免权限不足的 key 把前端卡在 token 接口。
ELEVENLABS_REQUIRE_SIGNED_URL = (
    os.getenv("ELEVENLABS_REQUIRE_SIGNED_URL", "").strip().lower() in {"1", "true", "yes", "on"}
)


def public_page_config(request_base_url: str = "") -> dict[str, Any]:
    local_url = f"{request_base_url.rstrip('/')}/elevenlabs" if request_base_url else ""
    custom_llm_url = ELEVENLABS_CUSTOM_LLM_URL or DEFAULT_PUBLIC_LLM_URL
    return {
        "agent_id": ELEVENLABS_AGENT_ID,
        "agent_configured": bool(ELEVENLABS_AGENT_ID),
        "signed_url_available": bool(
            ELEVENLABS_REQUIRE_SIGNED_URL and ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID
        ),
        "custom_llm_url": custom_llm_url,
        "custom_llm_local_url": local_url,
        "custom_llm_model": ELEVENLABS_CUSTOM_LLM_MODEL,
        "opening": {"zh": OPENING_ZH, "en": OPENING_EN},
        "system_prompt_note": (
            "人设以 EverEcho free_coach 为准。ElevenLabs Agent 的 system prompt 会被适配层忽略；"
            "请把 First message 设成 opening，或由本页在会话开始时覆盖。"
        ),
    }


def custom_llm_authorized(authorization: str | None, xi_api_key: str | None) -> bool:
    if not ELEVENLABS_CUSTOM_LLM_SECRET:
        return True
    candidates = [
        (authorization or "").removeprefix("Bearer ").strip(),
        (authorization or "").strip(),
        (xi_api_key or "").strip(),
    ]
    return any(
        candidate and secrets.compare_digest(candidate, ELEVENLABS_CUSTOM_LLM_SECRET)
        for candidate in candidates
    )


def _message_text(content: Any) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                parts.append(
                    str(
                        item.get("text")
                        or item.get("content")
                        or item.get("output_text")
                        or ""
                    )
                )
        return "".join(parts).strip()
    if isinstance(content, dict):
        return str(content.get("text") or content.get("content") or "").strip()
    return str(content).strip()


def extract_user_texts(messages: list[Any]) -> list[str]:
    texts: list[str] = []
    for raw in messages:
        if not isinstance(raw, dict):
            continue
        role = str(raw.get("role") or "").strip().lower()
        if role != "user":
            continue
        text = _message_text(raw.get("content"))
        if text:
            texts.append(text)
    return texts


def resolve_session_key(payload: dict[str, Any], user_texts: list[str]) -> str:
    candidates: list[Any] = [
        payload.get("session_id"),
        payload.get("elevenlabs_session_id"),
        payload.get("conversation_session_id"),
    ]
    extra = payload.get("custom_llm_extra_body") or payload.get("extra_body")
    if isinstance(extra, dict):
        candidates.extend(
            [
                extra.get("session_id"),
                extra.get("elevenlabs_session_id"),
                extra.get("conversation_session_id"),
            ]
        )
    # ElevenLabs 常把 SDK 的 userId 放进 user / user_id；与前端 EventSource 的 session UUID 对齐，不要加前缀。
    candidates.extend([payload.get("user"), payload.get("user_id")])
    for value in candidates:
        text = str(value or "").strip()
        if text:
            return text
    if user_texts:
        digest = hashlib.sha256(user_texts[0].encode("utf-8")).hexdigest()[:24]
        return f"first-user:{digest}"
    return f"opening:{uuid.uuid4().hex}"


def _publish_user_transcript_to_ui(payload: dict[str, Any], user_text: str, session_key: str) -> None:
    keys = {session_key}
    for value in (
        payload.get("session_id"),
        payload.get("user"),
        payload.get("user_id"),
    ):
        text = str(value or "").strip()
        if text:
            keys.add(text)
    extra = payload.get("custom_llm_extra_body") or payload.get("extra_body")
    if isinstance(extra, dict):
        text = str(extra.get("session_id") or "").strip()
        if text:
            keys.add(text)
    # ElevenLabs 可能丢掉 extra_body；把事件扇出到当前正在听 SSE 的会话（演示通常只有 1 个）。
    for active in list_active_ui_sessions():
        keys.add(active)
    event = {"type": "user_transcript", "text": user_text}
    for key in keys:
        publish_ui_event(key, event)
    logger.info(
        "elevenlabs ui user_transcript keys=%s active=%s payload_keys=%s chars=%s",
        [k[:20] for k in keys],
        len(list_active_ui_sessions()),
        sorted(str(k) for k in payload.keys()),
        len(user_text),
    )


def _prune_sessions(now: float) -> None:
    stale = [
        key
        for key, session in _sessions.items()
        if now - float(session.get("updated_at") or 0) > _SESSION_TTL_SECONDS
    ]
    for key in stale:
        _sessions.pop(key, None)
    if len(_sessions) <= _SESSION_MAX:
        return
    oldest = sorted(_sessions.items(), key=lambda item: float(item[1].get("updated_at") or 0))
    for key, _ in oldest[: max(0, len(_sessions) - _SESSION_MAX)]:
        _sessions.pop(key, None)


async def _ensure_session(session_key: str) -> dict[str, Any]:
    now = time.time()
    _prune_sessions(now)
    session = _sessions.get(session_key)
    if session:
        session["updated_at"] = now
        return session
    bootstrapped = await session_pool.take()
    session = {
        "token": bootstrapped["token"],
        "conversation_id": bootstrapped["conversation_id"],
        "last_user_text": "",
        "last_assistant_text": "",
        "updated_at": now,
    }
    _sessions[session_key] = session
    logger.info(
        "elevenlabs adapter session %s -> everecho %s",
        session_key[:16],
        session["conversation_id"],
    )
    return session


def _openai_chunk(chunk_id: str, model: str, created: int, delta: str | None, finish: str | None = None) -> str:
    payload = {
        "id": chunk_id,
        "object": "chat.completion.chunk",
        "created": created,
        "model": model,
        "choices": [
            {
                "index": 0,
                "delta": {"content": delta} if delta is not None else {},
                "finish_reason": finish,
            }
        ],
    }
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


def _sse_blocks(buffer: str) -> tuple[list[str], str]:
    buffer = buffer.replace("\r\n", "\n")
    blocks: list[str] = []
    while True:
        boundary = buffer.find("\n\n")
        if boundary < 0:
            return blocks, buffer
        blocks.append(buffer[:boundary])
        buffer = buffer[boundary + 2 :]


def _parse_sse_block(block: str) -> tuple[str, dict[str, Any]]:
    event_name = ""
    data_lines: list[str] = []
    for line in block.split("\n"):
        if line.startswith("event:"):
            event_name = line[6:].strip()
        elif line.startswith("data:"):
            data_lines.append(line[5:].lstrip())
    raw = "\n".join(data_lines)
    data: dict[str, Any] = {}
    if raw:
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, dict):
                data = parsed
            else:
                data = {"raw": parsed}
        except json.JSONDecodeError:
            data = {"raw": raw}
    return event_name, data


async def _stream_opening(model: str) -> AsyncIterator[bytes]:
    chunk_id = f"chatcmpl-{uuid.uuid4().hex[:24]}"
    created = int(time.time())
    yield _openai_chunk(chunk_id, model, created, OPENING_ZH).encode("utf-8")
    yield _openai_chunk(chunk_id, model, created, None, "stop").encode("utf-8")
    yield b"data: [DONE]\n\n"


async def _replay_text(model: str, text: str) -> AsyncIterator[bytes]:
    chunk_id = f"chatcmpl-{uuid.uuid4().hex[:24]}"
    created = int(time.time())
    if text:
        yield _openai_chunk(chunk_id, model, created, text).encode("utf-8")
    yield _openai_chunk(chunk_id, model, created, None, "stop").encode("utf-8")
    yield b"data: [DONE]\n\n"


async def _stream_everecho(session: dict[str, Any], user_text: str, model: str) -> AsyncIterator[bytes]:
    chunk_id = f"chatcmpl-{uuid.uuid4().hex[:24]}"
    created = int(time.time())
    collected = ""
    pending = ""
    error_message = ""

    async for raw in stream_free_coach_message(
        token=str(session["token"]),
        conversation_id=str(session["conversation_id"]),
        body=user_text,
        client_temp_id=str(uuid.uuid4()),
    ):
        pending += raw.decode("utf-8", errors="replace")
        blocks, pending = _sse_blocks(pending)
        for block in blocks:
            event_name, data = _parse_sse_block(block)
            if event_name == "assistant_delta":
                delta = str(data.get("text") or "")
                if not delta:
                    continue
                collected += delta
                yield _openai_chunk(chunk_id, model, created, delta).encode("utf-8")
            elif event_name == "assistant_message_done":
                body = str(data.get("body") or "").strip()
                if body:
                    collected = body
            elif event_name in {"assistant_failed", "error"}:
                error = data.get("error")
                if isinstance(error, dict):
                    error_message = str(error.get("message") or error.get("code") or "")
                else:
                    error_message = str(data.get("message") or data.get("raw") or "教练回复失败")

    if pending.strip():
        event_name, data = _parse_sse_block(pending)
        if event_name == "assistant_delta":
            delta = str(data.get("text") or "")
            if delta:
                collected += delta
                yield _openai_chunk(chunk_id, model, created, delta).encode("utf-8")
        elif event_name == "assistant_message_done":
            body = str(data.get("body") or "").strip()
            if body:
                collected = body
        elif event_name in {"assistant_failed", "error"} and not error_message:
            error = data.get("error")
            if isinstance(error, dict):
                error_message = str(error.get("message") or "")
            else:
                error_message = str(data.get("message") or "教练回复失败")

    if error_message and not collected:
        raise RuntimeError(error_message)

    session["last_user_text"] = user_text
    session["last_assistant_text"] = collected
    session["updated_at"] = time.time()
    yield _openai_chunk(chunk_id, model, created, None, "stop").encode("utf-8")
    yield b"data: [DONE]\n\n"


async def stream_free_coach_as_openai(payload: dict[str, Any]) -> AsyncIterator[bytes]:
    """Ignore ElevenLabs system prompt; only the latest user turn goes to EverEcho."""
    model = str(payload.get("model") or ELEVENLABS_CUSTOM_LLM_MODEL)
    messages = payload.get("messages")
    if not isinstance(messages, list):
        messages = []
    user_texts = extract_user_texts(messages)
    if not user_texts:
        async for chunk in _stream_opening(model):
            yield chunk
        return

    user_text = user_texts[-1]
    if len(user_text) > 8000:
        raise RuntimeError("消息过长")

    session_key = resolve_session_key(payload, user_texts)
    # 在打 EverEcho 之前就推用户转写，前端可立刻显示，不用等 LLM/ElevenLabs 回包。
    _publish_user_transcript_to_ui(payload, user_text, session_key)
    session = await _ensure_session(session_key)
    if user_text == session.get("last_user_text") and session.get("last_assistant_text"):
        async for chunk in _replay_text(model, str(session["last_assistant_text"])):
            yield chunk
        return

    async for chunk in _stream_everecho(session, user_text, model):
        yield chunk
