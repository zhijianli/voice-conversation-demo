"""豆包 Realtime Dialogue 二进制 WebSocket 协议（参考火山引擎官方示例）。"""

from __future__ import annotations

import gzip
import json
from typing import Any

PROTOCOL_VERSION = 0b0001

CLIENT_FULL_REQUEST = 0b0001
CLIENT_AUDIO_ONLY_REQUEST = 0b0010

SERVER_FULL_RESPONSE = 0b1001
SERVER_ACK = 0b1011
SERVER_ERROR_RESPONSE = 0b1111

NO_SEQUENCE = 0b0000
NEG_SEQUENCE = 0b0010
MSG_WITH_EVENT = 0b0100

NO_SERIALIZATION = 0b0000
JSON = 0b0001

NO_COMPRESSION = 0b0000
GZIP = 0b0001


def generate_header(
    *,
    message_type: int = CLIENT_FULL_REQUEST,
    message_type_specific_flags: int = MSG_WITH_EVENT,
    serial_method: int = JSON,
    compression_type: int = GZIP,
    reserved_data: int = 0x00,
    extension_header: bytes = b"",
) -> bytearray:
    header = bytearray()
    header_size = int(len(extension_header) / 4) + 1
    header.append((PROTOCOL_VERSION << 4) | header_size)
    header.append((message_type << 4) | message_type_specific_flags)
    header.append((serial_method << 4) | compression_type)
    header.append(reserved_data)
    header.extend(extension_header)
    return header


def parse_response(raw: bytes | str) -> dict[str, Any]:
    if isinstance(raw, str):
        return {}

    if len(raw) < 4:
        return {}

    header_size = raw[0] & 0x0F
    message_type = raw[1] >> 4
    message_type_specific_flags = raw[1] & 0x0F
    serialization_method = raw[2] >> 4
    message_compression = raw[2] & 0x0F

    payload = raw[header_size * 4 :]
    result: dict[str, Any] = {}
    payload_msg: bytes | dict[str, Any] | str | None = None
    start = 0

    if message_type in (SERVER_FULL_RESPONSE, SERVER_ACK):
        result["message_type"] = (
            "SERVER_ACK" if message_type == SERVER_ACK else "SERVER_FULL_RESPONSE"
        )
        if message_type_specific_flags & NEG_SEQUENCE:
            result["seq"] = int.from_bytes(payload[:4], "big", signed=False)
            start += 4
        if message_type_specific_flags & MSG_WITH_EVENT:
            result["event"] = int.from_bytes(payload[:4], "big", signed=False)
            start += 4
        payload = payload[start:]
        if len(payload) < 4:
            return result
        session_id_size = int.from_bytes(payload[:4], "big", signed=True)
        if session_id_size > 0 and len(payload) >= 4 + session_id_size + 4:
            session_id = payload[4 : 4 + session_id_size]
            result["session_id"] = session_id.decode("utf-8", errors="replace")
            payload = payload[4 + session_id_size :]
        else:
            payload = payload[4:]
        if len(payload) < 4:
            return result
        payload_size = int.from_bytes(payload[:4], "big", signed=False)
        payload_msg = payload[4 : 4 + payload_size]
    elif message_type == SERVER_ERROR_RESPONSE:
        result["message_type"] = "SERVER_ERROR"
        if len(payload) >= 8:
            result["code"] = int.from_bytes(payload[:4], "big", signed=False)
            payload_size = int.from_bytes(payload[4:8], "big", signed=False)
            payload_msg = payload[8 : 8 + payload_size]
    else:
        return result

    if payload_msg is None:
        return result

    if message_compression == GZIP and isinstance(payload_msg, bytes):
        payload_msg = gzip.decompress(payload_msg)
    if serialization_method == JSON and isinstance(payload_msg, bytes):
        payload_msg = json.loads(payload_msg.decode("utf-8"))
    elif serialization_method != NO_SERIALIZATION and isinstance(payload_msg, bytes):
        payload_msg = payload_msg.decode("utf-8", errors="replace")

    result["payload_msg"] = payload_msg
    return result


def build_full_request(
    event: int,
    payload: dict[str, Any] | str,
    *,
    session_id: str = "",
    serial_method: int = JSON,
    compression_type: int = GZIP,
) -> bytes:
    if isinstance(payload, dict):
        payload_bytes = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    else:
        payload_bytes = payload.encode("utf-8")
    if compression_type == GZIP:
        payload_bytes = gzip.compress(payload_bytes)

    request = bytearray(generate_header(serial_method=serial_method, compression_type=compression_type))
    request.extend(int(event).to_bytes(4, "big"))
    if session_id:
        encoded = session_id.encode("utf-8")
        request.extend(len(encoded).to_bytes(4, "big"))
        request.extend(encoded)
    request.extend(len(payload_bytes).to_bytes(4, "big"))
    request.extend(payload_bytes)
    return bytes(request)


def build_audio_request(event: int, audio: bytes, *, session_id: str) -> bytes:
    payload_bytes = gzip.compress(audio)
    request = bytearray(
        generate_header(
            message_type=CLIENT_AUDIO_ONLY_REQUEST,
            serial_method=NO_SERIALIZATION,
            compression_type=GZIP,
        )
    )
    request.extend(int(event).to_bytes(4, "big"))
    encoded = session_id.encode("utf-8")
    request.extend(len(encoded).to_bytes(4, "big"))
    request.extend(encoded)
    request.extend(len(payload_bytes).to_bytes(4, "big"))
    request.extend(payload_bytes)
    return bytes(request)
