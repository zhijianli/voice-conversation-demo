import { useCallback, useEffect, useRef, useState } from "react";
import { useConversation } from "@elevenlabs/react";
import { OPENING_TEXT } from "../lib/freeCoach";
import { API_BASE, type VoiceLanguage } from "../lib/voice";
import type { ConnectionStatus, Message } from "../types";

export interface ElevenLabsPublicConfig {
  agent_id: string;
  agent_configured: boolean;
  signed_url_available: boolean;
  custom_llm_url: string;
  custom_llm_model: string;
  opening: { zh: string; en: string };
  system_prompt_note: string;
}

/** 确保服务端推送中间转写；SDK 默认列表含此项，但 Agent 若自定义 client_events 常会漏掉。 */
const CLIENT_EVENTS = [
  "audio",
  "interruption",
  "user_transcript",
  "tentative_user_transcript",
  "agent_response",
  "agent_response_correction",
  "agent_chat_response_part",
] as const;

let messageCounter = 0;

function nextId() {
  return `el-${++messageCounter}`;
}

function mapStatus(
  status: "disconnected" | "connecting" | "connected" | "error"
): ConnectionStatus {
  if (status === "connecting") return "connecting";
  if (status === "connected") return "connected";
  if (status === "error") return "error";
  return "idle";
}

async function readJsonError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: string };
    if (payload.error) return payload.error;
  } catch {
    // ignore
  }
  return `HTTP ${response.status}`;
}

function normalizeText(text: string) {
  return text.trim().replace(/\s+/g, " ");
}

function readIncomingUserTranscript(event: unknown): { text: string; partial: boolean } | null {
  if (!event || typeof event !== "object") return null;
  const typed = event as {
    type?: string;
    user_transcription_event?: { user_transcript?: string };
    tentative_user_transcription_event?: { user_transcript?: string };
  };
  if (typed.type === "tentative_user_transcript") {
    const text = typed.tentative_user_transcription_event?.user_transcript?.trim() ?? "";
    return text ? { text, partial: true } : null;
  }
  if (typed.type === "user_transcript") {
    const text = typed.user_transcription_event?.user_transcript?.trim() ?? "";
    return text ? { text, partial: false } : null;
  }
  return null;
}

export function useElevenLabsVoice(language: VoiceLanguage) {
  const [config, setConfig] = useState<ElevenLabsPublicConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [micLoud, setMicLoud] = useState(false);
  const sessionIdRef = useRef(crypto.randomUUID());
  const startedRef = useRef(false);
  const userMsgIdRef = useRef<string | null>(null);
  /** 已显示过的用户文案（旁路 / SDK），避免重复气泡 */
  const shownUserTextsRef = useRef<Set<string>>(new Set());
  const eventSourceRef = useRef<EventSource | null>(null);

  const upsertUserMessage = useCallback((text: string, isPartial: boolean) => {
    const cleaned = text.trim();
    if (!cleaned) return;
    const normalized = normalizeText(cleaned);
    if (!isPartial && shownUserTextsRef.current.has(normalized)) {
      // 仍要把进行中气泡定稿
      setMessages((current) => {
        const lastUserIdx = [...current]
          .map((item, index) => ({ item, index }))
          .reverse()
          .find(({ item }) => item.role === "user")?.index;
        if (lastUserIdx == null || !current[lastUserIdx].isPartial) return current;
        return current.map((item, index) =>
          index === lastUserIdx ? { ...item, text: cleaned, isPartial: false } : item
        );
      });
      userMsgIdRef.current = null;
      return;
    }
    if (!isPartial) {
      shownUserTextsRef.current.add(normalized);
    }

    const id = userMsgIdRef.current ?? nextId();
    userMsgIdRef.current = id;
    setMessages((current) => {
      const index = current.findIndex((item) => item.id === id);
      const entry: Message = { id, role: "user", text: cleaned, isPartial };
      if (index >= 0) {
        const next = [...current];
        next[index] = entry;
        return next;
      }
      const last = current[current.length - 1];
      if (last?.role === "user" && (last.isPartial || normalizeText(last.text) === normalized)) {
        const next = [...current];
        next[next.length - 1] = entry;
        return next;
      }
      return [...current, entry];
    });
    if (!isPartial) {
      userMsgIdRef.current = null;
    }
  }, []);

  const closeSessionEvents = useCallback(() => {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
  }, []);

  const openSessionEvents = useCallback(
    (sessionId: string) => {
      closeSessionEvents();
      const source = new EventSource(
        `${API_BASE}/elevenlabs/session-events/${encodeURIComponent(sessionId)}`
      );
      eventSourceRef.current = source;
      source.onmessage = (raw) => {
        try {
          const payload = JSON.parse(raw.data) as { type?: string; text?: string };
          if (payload.type === "user_transcript" && payload.text) {
            upsertUserMessage(payload.text, false);
          }
        } catch {
          // ignore malformed ping/payload
        }
      };
      source.onerror = () => {
        // 浏览器会自动重连；保持引用即可
      };
    },
    [closeSessionEvents, upsertUserMessage]
  );

  const conversation = useConversation({
    onConnect: () => {
      startedRef.current = true;
      setLocalError(null);
    },
    onDisconnect: () => {
      startedRef.current = false;
      setMicLoud(false);
      userMsgIdRef.current = null;
      closeSessionEvents();
    },
    onError: (message) => {
      setLocalError(message);
    },
    onIncomingEvent: (event) => {
      const transcript = readIncomingUserTranscript(event);
      if (!transcript) return;
      upsertUserMessage(transcript.text, transcript.partial);
    },
    onMessage: ({ message, role }) => {
      const text = message.trim();
      if (!text) return;

      if (role === "user") {
        upsertUserMessage(text, false);
        return;
      }

      userMsgIdRef.current = null;
      setMessages((current) => {
        let next = current;
        const lastUserIdx = [...current]
          .map((item, index) => ({ item, index }))
          .reverse()
          .find(({ item }) => item.role === "user")?.index;
        if (lastUserIdx != null && current[lastUserIdx].isPartial) {
          next = current.map((item, index) =>
            index === lastUserIdx ? { ...item, isPartial: false } : item
          );
        }
        const last = next[next.length - 1];
        if (last?.role === "assistant" && last.text === text) {
          return next;
        }
        return [...next, { id: nextId(), role: "assistant", text }];
      });
    },
    onModeChange: ({ mode }) => {
      setMicLoud(mode === "listening");
    },
  });

  useEffect(() => {
    let cancelled = false;
    fetch(`${API_BASE}/elevenlabs/config`)
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(await readJsonError(response));
        }
        return response.json() as Promise<ElevenLabsPublicConfig>;
      })
      .then((payload) => {
        if (!cancelled) setConfig(payload);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setConfigError(error instanceof Error ? error.message : "无法读取 ElevenLabs 配置");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => () => closeSessionEvents(), [closeSessionEvents]);

  const connect = useCallback(async () => {
    if (!config?.agent_configured) {
      setLocalError("尚未配置 ELEVENLABS_AGENT_ID，无法开始 ElevenLabs 语音会话。");
      return;
    }
    setLocalError(null);
    setMessages([]);
    userMsgIdRef.current = null;
    shownUserTextsRef.current = new Set();
    sessionIdRef.current = crypto.randomUUID();
    // 先订阅旁路，再开 ElevenLabs，避免首条用户话在订阅前到达而丢失
    openSessionEvents(sessionIdRef.current);
    const opening = OPENING_TEXT[language];
    const extraBody = { session_id: sessionIdRef.current };
    const overrides = {
      agent: {
        firstMessage: opening,
        language: language === "zh" ? "zh" : "en",
      },
      conversation: {
        clientEvents: [...CLIENT_EVENTS],
      },
    } as const;

    // SDK 内部已会申请麦克风；这里不再先 getUserMedia 再 stop，避免重复占麦拖慢建连。
    // connectionDelay 默认桌面为 0；显式关掉，避免移动端默认 3s Android delay 拖慢。
    const connectionDelay = { default: 0, android: 0, ios: 0 } as const;

    try {
      if (config.signed_url_available) {
        try {
          const response = await fetch(`${API_BASE}/elevenlabs/conversation-token`);
          if (response.ok) {
            const payload = (await response.json()) as { token?: string };
            if (payload.token) {
              conversation.startSession({
                conversationToken: payload.token,
                connectionType: "webrtc",
                userId: sessionIdRef.current,
                customLlmExtraBody: extraBody,
                overrides: overrides as never,
                connectionDelay,
              });
              return;
            }
          }
        } catch {
          // token 失败时回退公开 agentId
        }
      }

      conversation.startSession({
        agentId: config.agent_id,
        connectionType: "webrtc",
        userId: sessionIdRef.current,
        customLlmExtraBody: extraBody,
        overrides: overrides as never,
        connectionDelay,
      });
    } catch (error: unknown) {
      closeSessionEvents();
      setLocalError(error instanceof Error ? error.message : "无法开始 ElevenLabs 会话");
    }
  }, [closeSessionEvents, config, conversation, language, openSessionEvents]);

  const disconnect = useCallback(() => {
    closeSessionEvents();
    conversation.endSession();
  }, [closeSessionEvents, conversation]);

  const sendTypedMessage = useCallback(
    (text: string) => {
      const body = text.trim();
      if (!body || conversation.status !== "connected") return;
      // 打字消息也立刻上屏；Custom LLM 旁路会再推一次，靠去重吞掉
      upsertUserMessage(body, false);
      conversation.sendUserMessage(body);
    },
    [conversation, upsertUserMessage]
  );

  const sdkStatus = mapStatus(conversation.status);
  const status: ConnectionStatus =
    localError && sdkStatus !== "connected" && sdkStatus !== "connecting"
      ? "error"
      : sdkStatus === "idle" && startedRef.current
        ? "disconnected"
        : sdkStatus;

  return {
    config,
    configError,
    status,
    messages,
    error: localError || configError,
    isSpeaking: conversation.isSpeaking,
    activityLabel:
      conversation.status === "connected"
        ? conversation.isSpeaking
          ? "教练正在说话…"
          : "等待你说话"
        : undefined,
    micLoud,
    connect,
    disconnect,
    sendTypedMessage,
  };
}
