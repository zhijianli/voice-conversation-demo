"""LiveKit 风格自主拼接管道配置（Deepgram STT + volo + MiniMax 女声 TTS）。"""

from __future__ import annotations

import os
from typing import Any

from deepgram_transcribe import deepgram_transcribe_config
from minimax_tts import MINIMAX_VOICE_ID, minimax_config

LIVEKIT_STT_PROVIDER = os.getenv("LIVEKIT_STT_PROVIDER", "deepgram")
LIVEKIT_TTS_PROVIDER = os.getenv("LIVEKIT_TTS_PROVIDER", "minimax")
LIVEKIT_DEFAULT_LANGUAGE = os.getenv("LIVEKIT_DEFAULT_LANGUAGE", "zh")


def livekit_config() -> dict[str, Any]:
    return {
        "stt_provider": LIVEKIT_STT_PROVIDER,
        "tts_provider": LIVEKIT_TTS_PROVIDER,
        "default_language": LIVEKIT_DEFAULT_LANGUAGE,
        "stt": deepgram_transcribe_config(),
        "tts": {
            **minimax_config(),
            "default_voice": MINIMAX_VOICE_ID,
            "female_voice_note": "默认 MiniMax 知性少女（女声）",
        },
        "llm": "volo free-coach",
    }
