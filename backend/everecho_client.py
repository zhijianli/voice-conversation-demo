from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any, AsyncIterator

import httpx
from dotenv import load_dotenv

load_dotenv(override=True)

EVERECHO_API_BASE_ONLINE = os.getenv(
    "EVERECHO_API_BASE_ONLINE", "https://api.volohorizon.com/v1"
).rstrip("/")
EVERECHO_API_BASE_LOCAL = os.getenv(
    "EVERECHO_API_BASE_LOCAL", "http://127.0.0.1:3000/v1"
).rstrip("/")
EVERECHO_TARGET = os.getenv("EVERECHO_TARGET", "auto").strip().lower() or "auto"
EVERECHO_TIME_ZONE = os.getenv("EVERECHO_TIME_ZONE", "Asia/Shanghai")
logger = logging.getLogger(__name__)


def _running_on_cloud_server() -> bool:
    flag = os.getenv("EVERECHO_ON_SERVER", "").strip().lower()
    if flag in {"1", "true", "yes", "on"}:
        return True
    if flag in {"0", "false", "no", "off"}:
        return False
    return Path("/home/ec2-user/projects").is_dir() or Path(
        "/etc/systemd/system/voice-conversation-demo.service"
    ).is_file() or Path(
        "/etc/systemd/system/gpt-realtime-demo.service"
    ).is_file()


def resolve_everecho_api_base() -> tuple[str, str]:
    """Pick EverEcho URL: laptop → public API, EC2 → loopback Node on :3000."""
    if EVERECHO_TARGET == "online":
        return EVERECHO_API_BASE_ONLINE, "online"
    if EVERECHO_TARGET == "local":
        return EVERECHO_API_BASE_LOCAL, "local"
    if EVERECHO_TARGET in {"override", "custom"}:
        forced = (os.getenv("EVERECHO_API_BASE") or "").strip().rstrip("/")
        if not forced:
            raise RuntimeError("EVERECHO_TARGET=override 时需要设置 EVERECHO_API_BASE")
        return forced, "override"
    if _running_on_cloud_server():
        return EVERECHO_API_BASE_LOCAL, "auto-local"
    return EVERECHO_API_BASE_ONLINE, "auto-online"


EVERECHO_API_BASE, EVERECHO_API_BASE_MODE = resolve_everecho_api_base()
logger.info(
    "EverEcho free-coach → %s (%s)",
    EVERECHO_API_BASE,
    EVERECHO_API_BASE_MODE,
)


def _error_detail(response: httpx.Response) -> str:
    try:
        payload = response.json()
    except Exception:
        text = response.text.strip()
        return text[:500] if text else f"HTTP {response.status_code}"

    if isinstance(payload, dict):
        error = payload.get("error")
        if isinstance(error, dict):
            message = error.get("message") or error.get("code")
            if message:
                return str(message)
        if payload.get("message"):
            return str(payload["message"])
    return f"HTTP {response.status_code}"


def everecho_config() -> dict[str, str]:
    return {
        "api_base": EVERECHO_API_BASE,
        "api_base_mode": EVERECHO_API_BASE_MODE,
        "time_zone": EVERECHO_TIME_ZONE,
    }


def _http_client(timeout: httpx.Timeout) -> httpx.AsyncClient:
    # 避免本机 127.0.0.1 请求被系统 HTTP_PROXY 劫持后一直挂起
    return httpx.AsyncClient(timeout=timeout, trust_env=False)


async def bootstrap_free_coach_session() -> dict[str, Any]:
    timeout = httpx.Timeout(20.0, connect=5.0)
    try:
        async with _http_client(timeout) as client:
            example_response = await client.post(
                f"{EVERECHO_API_BASE}/dev/free-coach-example",
                json={"time_zone_identifier": EVERECHO_TIME_ZONE},
            )
            if example_response.status_code >= 400:
                if example_response.status_code in (502, 503, 504):
                    raise RuntimeError(
                        f"EverEcho 不可用（{EVERECHO_API_BASE} 返回 HTTP {example_response.status_code}）。"
                    )
                raise RuntimeError(
                    f"创建 EverEcho 测试账号失败：{_error_detail(example_response)}"
                )

            example = example_response.json()
            token = example.get("token")
            if not token:
                raise RuntimeError("EverEcho 未返回 session token")

            conversation_response = await client.post(
                f"{EVERECHO_API_BASE}/coach/conversations",
                headers={"Authorization": f"Bearer {token}"},
                json={
                    "kind": "free_coach",
                    "time_zone_identifier": EVERECHO_TIME_ZONE,
                },
            )
            if conversation_response.status_code >= 400:
                raise RuntimeError(
                    f"创建 free_coach 会话失败：{_error_detail(conversation_response)}"
                )

            created = conversation_response.json()
            conversation = created.get("conversation") or {}
            conversation_id = conversation.get("id")
            if not conversation_id:
                raise RuntimeError("EverEcho 未返回 conversation id")

            opening = created.get("opening_message") or {}
            return {
                "token": token,
                "conversation_id": conversation_id,
                "opening_text": (opening.get("body") or "").strip(),
                "vision": example.get("vision"),
            }
    except RuntimeError:
        raise
    except httpx.ConnectError as exc:
        raise RuntimeError(
            f"无法连接 EverEcho（{EVERECHO_API_BASE}）。请检查网络或 EVERECHO_API_BASE 配置。"
        ) from exc
    except httpx.TimeoutException as exc:
        raise RuntimeError(
            f"连接 EverEcho 超时（{EVERECHO_API_BASE}）。请确认线上服务可访问。"
        ) from exc


async def stream_free_coach_message(
    *,
    token: str,
    conversation_id: str,
    body: str,
    client_temp_id: str | None = None,
) -> AsyncIterator[bytes]:
    payload: dict[str, Any] = {"body": body}
    if client_temp_id:
        payload["client_temp_id"] = client_temp_id

    timeout = httpx.Timeout(180.0, connect=8.0)
    async with _http_client(timeout) as client:
        async with client.stream(
            "POST",
            f"{EVERECHO_API_BASE}/coach/conversations/{conversation_id}/messages/stream",
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "text/event-stream",
                "Content-Type": "application/json",
            },
            json=payload,
        ) as response:
            if response.status_code >= 400:
                await response.aread()
                detail = _error_detail(response)
                logger.warning("free-coach stream failed: %s", detail)
                yield (
                    "event: error\n"
                    f"data: {json.dumps({'code': 'UPSTREAM', 'message': detail}, ensure_ascii=False)}\n\n"
                ).encode("utf-8")
                return

            async for chunk in response.aiter_bytes():
                if chunk:
                    yield chunk
