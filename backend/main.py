import json
import os

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware

from prompts import (
    LANGFUSE_CONSTITUTION_PROMPT_NAME,
    LANGFUSE_PROMPT_LABEL,
    LANGFUSE_PROMPT_NAME,
    get_instructions,
)

load_dotenv()

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
REALTIME_MODEL = os.getenv("REALTIME_MODEL", "gpt-realtime-2.1")
OPENAI_REALTIME_CALLS_URL = "https://api.openai.com/v1/realtime/calls"

AUDIO_CONFIG = {
    "input": {
        "turn_detection": {"type": "server_vad"},
        "transcription": {
            "model": "gpt-4o-mini-transcribe",
            "language": "zh",
        },
    },
    "output": {"voice": "marin"},
}


def build_session_config(*, use_langfuse: bool) -> dict:
    instructions, _ = get_instructions(use_langfuse=use_langfuse)
    return {
        "type": "realtime",
        "model": REALTIME_MODEL,
        "instructions": instructions,
        "audio": AUDIO_CONFIG,
    }

app = FastAPI(title="OpenAI Realtime Demo API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
async def health():
    return {
        "status": "ok",
        "model": REALTIME_MODEL,
        "langfuse_constitution": LANGFUSE_CONSTITUTION_PROMPT_NAME,
        "langfuse_node": LANGFUSE_PROMPT_NAME,
        "langfuse_label": LANGFUSE_PROMPT_LABEL,
    }


@app.post("/api/session")
async def create_session(
    request: Request,
    use_langfuse: bool = Query(False),
):
    if not OPENAI_API_KEY:
        return Response(
            content=json.dumps({"error": "OPENAI_API_KEY 未配置，请检查 backend/.env"}),
            status_code=500,
            media_type="application/json",
        )

    sdp = await request.body()
    if not sdp:
        return Response(
            content=json.dumps({"error": "缺少 SDP 数据"}),
            status_code=400,
            media_type="application/json",
        )

    session_config = build_session_config(use_langfuse=use_langfuse)

    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.post(
            OPENAI_REALTIME_CALLS_URL,
            headers={"Authorization": f"Bearer {OPENAI_API_KEY}"},
            files=[
                ("sdp", (None, sdp, "application/sdp")),
                ("session", (None, json.dumps(session_config), "application/json")),
            ],
        )

    if response.status_code != 200 and response.status_code != 201:
        return Response(
            content=json.dumps(
                {
                    "error": "OpenAI Realtime API 请求失败",
                    "detail": response.text,
                }
            ),
            status_code=response.status_code,
            media_type="application/json",
        )

    return Response(content=response.text, media_type="application/sdp")
