import { useCallback, useRef, useState } from "react";
import type { ConnectionStatus, Message, RealtimeActions, RealtimeState } from "../types";
import { API_BASE, createMicCapture } from "../lib/voice";

export type S2SProvider = "bailian" | "gemini" | "doubao" | "deepgram";

let messageCounter = 0;

function nextId() {
  return `s2s-${++messageCounter}`;
}

function transcriptFamily(type: string): "output" | "legacy" {
  return type.includes("output_audio_transcript") ? "output" : "legacy";
}

function s2sSocketUrl(
  provider: S2SProvider,
  useLangfuse: boolean,
  sessionId: string
): string {
  const params = new URLSearchParams({
    use_langfuse: useLangfuse ? "true" : "false",
  });
  if (provider === "deepgram" && sessionId) {
    params.set("session_id", sessionId);
  }
  const query = `?${params.toString()}`;
  if (import.meta.env.DEV) {
    if (provider === "deepgram") {
      return `ws://127.0.0.1:8000/api/deepgram/ws${query}`;
    }
    return `ws://127.0.0.1:8000/api/s2s/${provider}/ws${query}`;
  }
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  if (provider === "deepgram") {
    return `${protocol}//${window.location.host}${API_BASE}/deepgram/ws${query}`;
  }
  return `${protocol}//${window.location.host}${API_BASE}/s2s/${provider}/ws${query}`;
}

function pcm16ToAudioBuffer(
  ctx: AudioContext,
  pcm: ArrayBuffer,
  sampleRate: number
): AudioBuffer {
  const samples = new Int16Array(pcm);
  const buffer = ctx.createBuffer(1, samples.length, sampleRate);
  const channel = buffer.getChannelData(0);
  for (let i = 0; i < samples.length; i += 1) {
    channel[i] = samples[i] / 32768;
  }
  return buffer;
}

export function useS2SWebSocket(provider: S2SProvider): RealtimeState & RealtimeActions {
  const [status, setStatus] = useState<ConnectionStatus>("idle");
  const [messages, setMessages] = useState<Message[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isSpeaking, setIsSpeaking] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const captureStopRef = useRef<(() => void) | null>(null);
  const playbackCtxRef = useRef<AudioContext | null>(null);
  const playbackEndAtRef = useRef(0);
  const playbackSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const assistantDraftRef = useRef("");
  const assistantMsgIdRef = useRef<string | null>(null);
  const userPendingMsgIdRef = useRef<string | null>(null);
  const transcriptSourceRef = useRef<"output" | "legacy" | null>(null);
  const sessionIdRef = useRef(crypto.randomUUID());

  const resetAssistantDraft = useCallback(() => {
    assistantDraftRef.current = "";
    assistantMsgIdRef.current = null;
    transcriptSourceRef.current = null;
  }, []);

  const resetUserPending = useCallback(() => {
    userPendingMsgIdRef.current = null;
  }, []);

  const stopPlayback = useCallback(() => {
    for (const source of playbackSourcesRef.current) {
      try {
        source.stop();
      } catch {
        // already stopped
      }
    }
    playbackSourcesRef.current = [];
    playbackEndAtRef.current = 0;
  }, []);

  const scheduleAudio = useCallback((pcm: ArrayBuffer, sampleRate = 24000) => {
    const ctx = playbackCtxRef.current ?? new AudioContext();
    playbackCtxRef.current = ctx;
    void ctx.resume();

    const buffer = pcm16ToAudioBuffer(ctx, pcm, sampleRate);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);

    const now = ctx.currentTime;
    const startAt = Math.max(now, playbackEndAtRef.current);
    source.start(startAt);
    playbackEndAtRef.current = startAt + buffer.duration;
    playbackSourcesRef.current.push(source);
    source.onended = () => {
      playbackSourcesRef.current = playbackSourcesRef.current.filter((s) => s !== source);
    };
  }, []);

  const upsertAssistantMessage = useCallback((text: string, isPartial: boolean) => {
    setMessages((prev) => {
      let index = assistantMsgIdRef.current
        ? prev.findIndex((m) => m.id === assistantMsgIdRef.current)
        : -1;
      if (index < 0) {
        for (let i = prev.length - 1; i >= 0; i -= 1) {
          if (prev[i].role === "assistant" && prev[i].isPartial) {
            index = i;
            break;
          }
        }
      }
      const id = index >= 0 ? prev[index].id : nextId();
      assistantMsgIdRef.current = id;
      const entry: Message = { id, role: "assistant", text, isPartial };
      if (index >= 0) {
        const next = [...prev];
        next[index] = entry;
        return next;
      }
      return [...prev, entry];
    });
  }, []);

  const completeUserTranscript = useCallback(
    (transcript: string) => {
      const text = transcript.trim();
      if (!text) return;
      const pendingId = userPendingMsgIdRef.current;
      if (pendingId) {
        setMessages((prev) => {
          const index = prev.findIndex((m) => m.id === pendingId);
          if (index < 0) return prev;
          const next = [...prev];
          next[index] = { id: pendingId, role: "user", text };
          return next;
        });
        resetUserPending();
      } else {
        setMessages((prev) => [...prev, { id: nextId(), role: "user", text }]);
      }
    },
    [resetUserPending]
  );

  const finalizeAssistantMessage = useCallback(() => {
    const currentId = assistantMsgIdRef.current;
    setMessages((prev) => {
      let changed = false;
      const next = prev.map((m) => {
        if (m.role === "assistant" && (m.id === currentId || m.isPartial)) {
          changed = true;
          return { ...m, isPartial: false };
        }
        return m;
      });
      return changed ? next : prev;
    });
    resetAssistantDraft();
  }, [resetAssistantDraft]);

  const acceptTranscriptEvent = (type: string) => {
    const family = transcriptFamily(type);
    if (transcriptSourceRef.current && transcriptSourceRef.current !== family) {
      return false;
    }
    transcriptSourceRef.current = family;
    return true;
  };

  const handleServerEvent = useCallback(
    (event: Record<string, unknown>) => {
      const type = event.type as string;
      switch (type) {
        case "response.created":
          if (!assistantMsgIdRef.current) {
            assistantDraftRef.current = "";
            transcriptSourceRef.current = null;
          }
          break;
        case "response.cancelled":
          stopPlayback();
          finalizeAssistantMessage();
          break;
        case "input_audio_buffer.speech_started":
          stopPlayback();
          finalizeAssistantMessage();
          setIsSpeaking(true);
          break;
        case "input_audio_buffer.speech_stopped": {
          setIsSpeaking(false);
          const userId = nextId();
          userPendingMsgIdRef.current = userId;
          setMessages((prev) => [
            ...prev,
            { id: userId, role: "user", text: "…", isPartial: true },
          ]);
          break;
        }
        case "conversation.item.input_audio_transcription.completed":
          completeUserTranscript((event.transcript as string) ?? "");
          break;
        case "response.output_audio_transcript.delta":
        case "response.audio_transcript.delta": {
          if (!acceptTranscriptEvent(type)) break;
          const delta = (event.delta as string) ?? "";
          assistantDraftRef.current += delta;
          upsertAssistantMessage(assistantDraftRef.current, true);
          break;
        }
        case "response.output_audio_transcript.done":
        case "response.audio_transcript.done": {
          if (!acceptTranscriptEvent(type)) break;
          const transcript =
            (event.transcript as string | undefined) ?? assistantDraftRef.current;
          if (transcript.trim()) {
            assistantDraftRef.current = transcript;
            upsertAssistantMessage(transcript, false);
          }
          break;
        }
        case "response.audio.delta": {
          const delta = event.delta as string | undefined;
          if (!delta) break;
          const sampleRate = Number(event.sample_rate ?? 24000);
          const binary = Uint8Array.from(atob(delta), (c) => c.charCodeAt(0));
          scheduleAudio(binary.buffer, sampleRate);
          break;
        }
        case "response.done":
          finalizeAssistantMessage();
          break;
        case "error":
          setError(
            ((event.error as { message?: string } | undefined)?.message) ?? "未知错误"
          );
          break;
        default:
          break;
      }
    },
    [
      completeUserTranscript,
      finalizeAssistantMessage,
      scheduleAudio,
      stopPlayback,
      upsertAssistantMessage,
    ]
  );

  const cleanup = useCallback(() => {
    wsRef.current?.close();
    wsRef.current = null;
    captureStopRef.current?.();
    captureStopRef.current = null;
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;
    stopPlayback();
    if (playbackCtxRef.current) {
      void playbackCtxRef.current.close();
      playbackCtxRef.current = null;
    }
    resetAssistantDraft();
    resetUserPending();
    setIsSpeaking(false);
  }, [resetAssistantDraft, resetUserPending, stopPlayback]);

  const connect = useCallback(
    async (useLangfuse = true) => {
      if (status === "connecting" || status === "connected") return;

      setStatus("connecting");
      setError(null);
      setMessages([]);

      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error(
            "当前页面无法访问麦克风，请使用 HTTPS 域名访问（例如 https://api.volohorizon.com/realtime/）"
          );
        }

        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaStreamRef.current = stream;

        const ws = new WebSocket(
          s2sSocketUrl(provider, useLangfuse, sessionIdRef.current)
        );
        wsRef.current = ws;

        await new Promise<void>((resolve, reject) => {
          ws.onopen = () => resolve();
          ws.onerror = () => reject(new Error("WebSocket 连接失败"));
        });

        ws.onmessage = (event) => {
          try {
            handleServerEvent(JSON.parse(event.data as string));
          } catch {
            // ignore malformed events
          }
        };

        ws.onclose = () => {
          if (status !== "error") {
            setStatus("disconnected");
          }
        };

        const capture = await createMicCapture(stream, (pcm) => {
          if (ws.readyState !== WebSocket.OPEN) return;
          const bytes = new Uint8Array(pcm);
          let binary = "";
          for (let i = 0; i < bytes.length; i += 1) {
            binary += String.fromCharCode(bytes[i]);
          }
          ws.send(
            JSON.stringify({
              type: "input_audio_buffer.append",
              audio: btoa(binary),
            })
          );
        });

        captureStopRef.current = capture.stop;
        setStatus("connected");
      } catch (err) {
        cleanup();
        setStatus("error");
        setError(err instanceof Error ? err.message : "连接失败");
      }
    },
    [cleanup, handleServerEvent, provider, status]
  );

  const disconnect = useCallback(() => {
    cleanup();
    setStatus("idle");
  }, [cleanup]);

  return { status, messages, error, isSpeaking, connect, disconnect };
}
