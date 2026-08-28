import logging
import os

logger = logging.getLogger(__name__)

DEFAULT_INSTRUCTIONS = (
    "你是一个友好的中文语音助手。"
    "请用简洁、自然的中文与用户对话。"
    "回答要简短，适合语音交流，避免使用 markdown 或列表格式。"
)

LANGFUSE_CONSTITUTION_PROMPT_NAME = os.getenv(
    "LANGFUSE_CONSTITUTION_PROMPT_NAME", "everecho/constitution/dialogue"
)
LANGFUSE_PROMPT_NAME = os.getenv(
    "LANGFUSE_PROMPT_NAME", "everecho/free_coach/default"
)
LANGFUSE_PROMPT_LABEL = os.getenv("LANGFUSE_PROMPT_LABEL", "staging")
LANGFUSE_PROMPT_CACHE_TTL_SECONDS = int(
    os.getenv("LANGFUSE_PROMPT_CACHE_TTL_SECONDS", "60")
)

VOICE_SUFFIX = (
    "\n\n## Voice Mode\n"
    "You are in a realtime voice conversation. "
    "Keep each reply to 2-4 short spoken sentences. "
    "No bullet lists, markdown, or numbered steps."
)

_langfuse = None


def _get_langfuse():
    global _langfuse
    if _langfuse is None:
        from langfuse import get_client

        _langfuse = get_client()
    return _langfuse


def _fetch_prompt(name: str):
    langfuse = _get_langfuse()
    return langfuse.get_prompt(
        name,
        label=LANGFUSE_PROMPT_LABEL,
        cache_ttl_seconds=LANGFUSE_PROMPT_CACHE_TTL_SECONDS,
    )


def get_instructions(*, use_langfuse: bool) -> tuple[str, str]:
    """Return (instructions, source) where source is 'default' or 'langfuse'."""
    if not use_langfuse:
        return DEFAULT_INSTRUCTIONS, "default"

    try:
        constitution = _fetch_prompt(LANGFUSE_CONSTITUTION_PROMPT_NAME)
        node = _fetch_prompt(LANGFUSE_PROMPT_NAME)

        instructions = (
            constitution.compile()
            + "\n\n---\n\n## Current Node\n\n"
            + node.compile()
            + VOICE_SUFFIX
        )
        logger.info(
            "Loaded Langfuse prompts constitution=%s v%s, node=%s v%s (label=%s)",
            LANGFUSE_CONSTITUTION_PROMPT_NAME,
            constitution.version,
            LANGFUSE_PROMPT_NAME,
            node.version,
            LANGFUSE_PROMPT_LABEL,
        )
        return instructions, "langfuse"
    except Exception:
        logger.exception(
            "Failed to fetch Langfuse prompts (%s + %s), falling back to default",
            LANGFUSE_CONSTITUTION_PROMPT_NAME,
            LANGFUSE_PROMPT_NAME,
        )
        return DEFAULT_INSTRUCTIONS, "default"
