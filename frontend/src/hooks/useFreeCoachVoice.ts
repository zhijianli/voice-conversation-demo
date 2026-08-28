import { useCallback, useRef, useState } from "react";
import type { ConnectionStatus, Message, RoundLatency } from "../types";
import {
  API_BASE,
  createMicCapture,
  drainSentences,
  readSseStream,
  transcribeSocketUrl,
  pcmRms,
} from "../lib/voice";

const ENDPOINT_SILENCE_MS = 800;
const POST_TTS_HOLD_MS = 400;
const FINAL_FLUSH_MS = 350;

export type VoicePhase =
  | "idle"
  | "connecting"
  | "listening"
  | "hearing"
  | "thinking"
  | "speaking";

export interface FreeCoachVoiceState {
  status: ConnectionStatus;
  phase: VoicePhase;
  messages: Message[];
  error: string | null;
  isSpeaking: boolean;
}

let messageCounter = 0;

function nextId() {
  return `fc-${++messageCounter}`;
}

function joinTranscript(left: string, right: string): string {
  const a = left.trim();
  const b = right.trim();
  if (!a) return b;
  if (!b) return a;
  if (a.endsWith(b)) return a;
  if (b.startsWith(a)) return b;
  return `${a} ${b}`;
}

function phaseLabel(phase: VoicePhase): string {
  switch (phase) {
    case "connecting":
      return "正在准备会话…";
    case "hearing":
      return "正在识别…";
    case "thinking":
      return "教练思考中…";
    case "speaking":
      return "正在播放回复…";
    case "listening":
      return "等待你说话";
    default:
      return "未连接";
  }
}

export function useFreeCoachVoice() {
  const [status, setStatus] = useState<ConnectionStatus>("idle");
  const [phase, setPhase] = useState<VoicePhase>("idle");
  const [messages, setMessages] = useState<Message[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [sttText, setSttText] = useState("");
  const [sttPartial, setSttPartial] = useState(false);
  const [micLoud, setMicLoud] = useState(false);

  const tokenRef = useRef("");
  const conversationIdRef = useRef("");
  const wsRef = useRef<WebSocket | null>(null);
  const captureStopRef = useRef<(() => void) | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const pausedRef = useRef(false);
  const busyRef = useRef(false);
  const closedRef = useRef(false);
  const userMsgIdRef = useRef<string | null>(null);
  const assistantMsgIdRef = useRef<string | null>(null);
  const committedSttRef = useRef("");
  const finalTimerRef = useRef<number | null>(null);
  const playbackCtxRef = useRef<AudioContext | null>(null);
  const playbackSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const playbackEndAtRef = useRef(0);
  const playingRef = useRef(false);
  const ttsInFlightRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const speakChainRef = useRef(Promise.resolve());
  const sttLiveRef = useRef("");
  const endpointTimerRef = useRef<number | null>(null);
  const unmuteAtRef = useRef(0);
  const noiseFloorRef = useRef(0.008);
  const micLoudRef = useRef(false);
  const asrGateStartedAtRef = useRef<number | null>(null);

  const cleanupAudioQueue = useCallback(() => {
    playbackSourcesRef.current.forEach((source) => {
      try {
        source.stop();
      } catch {
        // already stopped
      }
    });
    playbackSourcesRef.current = [];
    playbackEndAtRef.current = 0;
    playingRef.current = false;
    if (playbackCtxRef.current) {
      void playbackCtxRef.current.close();
      playbackCtxRef.current = null;
    }
  }, []);

  const cleanup = useCallback(() => {
    closedRef.current = true;
    busyRef.current = false;
    pausedRef.current = false;
    abortRef.current?.abort();
    abortRef.current = null;
    if (finalTimerRef.current) {
      window.clearTimeout(finalTimerRef.current);
      finalTimerRef.current = null;
    }
    if (endpointTimerRef.current) {
      window.clearTimeout(endpointTimerRef.current);
      endpointTimerRef.current = null;
    }
    cleanupAudioQueue();
    captureStopRef.current?.();
    captureStopRef.current = null;
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;
    if (wsRef.current) {
      try {
        wsRef.current.send(JSON.stringify({ type: "stop" }));
      } catch {
        // ignore
      }
      wsRef.current.close();
      wsRef.current = null;
    }
    userMsgIdRef.current = null;
    assistantMsgIdRef.current = null;
    committedSttRef.current = "";
    sttLiveRef.current = "";
    unmuteAtRef.current = 0;
    asrGateStartedAtRef.current = null;
    ttsInFlightRef.current = 0;
    speakChainRef.current = Promise.resolve();
    setSttText("");
    setSttPartial(false);
    setMicLoud(false);
    setIsSpeaking(false);
    setPhase("idle");
  }, [cleanupAudioQueue]);

  const upsertMessage = useCallback(
    (
      id: string,
      role: Message["role"],
      text: string,
      isPartial: boolean,
      latency?: RoundLatency
    ) => {
      setMessages((prev) => {
        const index = prev.findIndex((item) => item.id === id);
        const previous = index >= 0 ? prev[index] : undefined;
        const entry: Message = {
          id,
          role,
          text,
          isPartial,
          latency: latency ?? previous?.latency,
        };
        if (index >= 0) {
          const next = [...prev];
          next[index] = entry;
          return next;
        }
        return [...prev, entry];
      });
    },
    []
  );

  const finishSpeakingIfIdle = useCallback(() => {
    if (ttsInFlightRef.current > 0) return;
    const ctx = playbackCtxRef.current;
    if (ctx && ctx.currentTime < playbackEndAtRef.current - 0.04) return;
    playingRef.current = false;
    if (busyRef.current || closedRef.current) return;
    pausedRef.current = false;
    unmuteAtRef.current = Date.now() + POST_TTS_HOLD_MS;
    setPhase("listening");
    setIsSpeaking(false);
  }, []);

  const enqueueAudio = useCallback(
    async (blob: Blob) => {
      if (closedRef.current) return;
      const ctx = playbackCtxRef.current ?? new AudioContext();
      playbackCtxRef.current = ctx;
      await ctx.resume();
      const encoded = await blob.arrayBuffer();
      const buffer = await ctx.decodeAudioData(encoded.slice(0));
      if (closedRef.current) return;

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      const startAt = Math.max(ctx.currentTime, playbackEndAtRef.current);
      source.start(startAt);
      playbackEndAtRef.current = startAt + buffer.duration;
      playbackSourcesRef.current.push(source);
      playingRef.current = true;
      pausedRef.current = true;
      setPhase("speaking");
      setIsSpeaking(true);
      source.onended = () => {
        playbackSourcesRef.current = playbackSourcesRef.current.filter(
          (item) => item !== source
        );
        finishSpeakingIfIdle();
      };
    },
    [finishSpeakingIfIdle]
  );

  const speakText = useCallback(
    (text: string) => {
      const cleaned = text.trim();
      if (!cleaned || closedRef.current) return speakChainRef.current;

      ttsInFlightRef.current += 1;
      const blobPromise = (async () => {
        const response = await fetch(`${API_BASE}/free-coach/tts`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: cleaned }),
        });
        if (!response.ok) {
          let detail = response.statusText;
          try {
            const payload = await response.json();
            detail = payload.error ?? payload.detail ?? detail;
          } catch {
            // ignore
          }
          throw new Error(detail);
        }
        return response.blob();
      })();

      speakChainRef.current = speakChainRef.current
        .then(async () => {
          if (closedRef.current) return;
          await enqueueAudio(await blobPromise);
        })
        .catch((err) => {
          if (!closedRef.current) {
            setError(err instanceof Error ? err.message : "语音合成失败");
          }
        })
        .finally(() => {
          ttsInFlightRef.current = Math.max(0, ttsInFlightRef.current - 1);
          finishSpeakingIfIdle();
        });

      return speakChainRef.current;
    },
    [enqueueAudio, finishSpeakingIfIdle]
  );

  const sendToCoach = useCallback(
    async (text: string, asrMs: number | null = null) => {
      const cleaned = text.trim();
      if (!cleaned || closedRef.current) return;
      if (!tokenRef.current || !conversationIdRef.current) {
        setError("会话尚未准备好");
        return;
      }

      busyRef.current = true;
      pausedRef.current = true;
      setPhase("thinking");
      setIsSpeaking(false);

      const assistantId = nextId();
      assistantMsgIdRef.current = assistantId;
      const pendingLatency: RoundLatency = {
        asrMs,
        llmMs: null,
        ttsMs: null,
        totalMs: null,
        phase: "llm",
      };
      upsertMessage(assistantId, "assistant", "", true, pendingLatency);

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      let draft = "";
      let pendingSpeak = "";
      const llmStarted = performance.now();
      let firstSentenceAt: number | null = null;
      let ttsFirstMs: number | null = null;

      const queueSentence = (sentence: string) => {
        if (firstSentenceAt == null) {
          firstSentenceAt = performance.now();
          const ttsStarted = performance.now();
          void speakText(sentence).then(() => {
            if (ttsFirstMs == null) ttsFirstMs = performance.now() - ttsStarted;
          });
        } else {
          void speakText(sentence);
        }
      };

      try {
        const response = await fetch(`${API_BASE}/free-coach/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            token: tokenRef.current,
            conversation_id: conversationIdRef.current,
            body: cleaned,
            client_temp_id: crypto.randomUUID(),
          }),
        });

        if (!response.ok) {
          let detail = response.statusText;
          try {
            const payload = await response.json();
            detail = payload.error ?? payload.detail ?? detail;
          } catch {
            // ignore
          }
          throw new Error(detail);
        }

        await readSseStream(response, (event, data) => {
          if (event === "assistant_delta") {
            draft += String(data.text ?? "");
            pendingSpeak += String(data.text ?? "");
            upsertMessage(assistantId, "assistant", draft, true);
            const { sentences, rest } = drainSentences(pendingSpeak);
            pendingSpeak = rest;
            for (const sentence of sentences) {
              queueSentence(sentence);
            }
          } else if (event === "assistant_message_done") {
            draft = String(data.body ?? draft);
            upsertMessage(assistantId, "assistant", draft, false);
          } else if (event === "assistant_failed" || event === "error") {
            const err = data.error as { message?: string } | undefined;
            throw new Error(
              err?.message || String(data.message ?? "教练回复失败")
            );
          }
        });

        const leftover = pendingSpeak.trim();
        if (leftover) queueSentence(leftover);
        await speakChainRef.current;

        const llmMs =
          (firstSentenceAt ?? performance.now()) - llmStarted;
        const ttsMs = ttsFirstMs;
        upsertMessage(assistantId, "assistant", draft, false, {
          asrMs,
          llmMs,
          ttsMs,
          totalMs: (asrMs ?? 0) + llmMs + (ttsMs ?? 0),
          phase: "done",
        });

        if (!playingRef.current && !closedRef.current) {
          pausedRef.current = false;
          setPhase("listening");
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        upsertMessage(
          assistantId,
          "assistant",
          draft || "（本轮回复失败）",
          false
        );
        setError(err instanceof Error ? err.message : "教练回复失败");
        pausedRef.current = false;
        setPhase("listening");
      } finally {
        busyRef.current = false;
        abortRef.current = null;
        assistantMsgIdRef.current = null;
      }
    },
    [speakText, upsertMessage]
  );

  const flushFinalTranscript = useCallback(() => {
    if (finalTimerRef.current) {
      window.clearTimeout(finalTimerRef.current);
      finalTimerRef.current = null;
    }
    if (endpointTimerRef.current) {
      window.clearTimeout(endpointTimerRef.current);
      endpointTimerRef.current = null;
    }
    const text = joinTranscript(committedSttRef.current, sttLiveRef.current);
    committedSttRef.current = "";
    sttLiveRef.current = "";
    if (!text) return;
    const userId = userMsgIdRef.current ?? nextId();
    userMsgIdRef.current = null;
    setSttText("");
    setSttPartial(false);
    const asrMs = asrGateStartedAtRef.current
      ? performance.now() - asrGateStartedAtRef.current
      : null;
    asrGateStartedAtRef.current = null;
    upsertMessage(userId, "user", text, false);
    void sendToCoach(text, asrMs);
  }, [sendToCoach, upsertMessage]);

  const cancelEndpoint = useCallback(() => {
    if (endpointTimerRef.current) {
      window.clearTimeout(endpointTimerRef.current);
      endpointTimerRef.current = null;
    }
  }, []);

  const scheduleEndpoint = useCallback(() => {
    if (endpointTimerRef.current) return;
    if (asrGateStartedAtRef.current == null) {
      asrGateStartedAtRef.current = performance.now();
    }
    endpointTimerRef.current = window.setTimeout(() => {
      endpointTimerRef.current = null;
      if (busyRef.current || pausedRef.current || closedRef.current) return;
      flushFinalTranscript();
    }, ENDPOINT_SILENCE_MS);
  }, [flushFinalTranscript]);

  const handleTranscript = useCallback(
    (payload: { type: string; text?: string; message?: string }) => {
      if (payload.type === "error") {
        setError(payload.message || "语音识别出错");
        return;
      }
      if (payload.type === "partial") {
        const text = (payload.text || "").trim();
        if (text) {
          sttLiveRef.current = text;
          setSttText(joinTranscript(committedSttRef.current, text));
          setSttPartial(true);
        }
        cancelEndpoint();
        asrGateStartedAtRef.current = null;
        if (busyRef.current || pausedRef.current) return;
        if (!text && !committedSttRef.current.trim()) return;
        const id = userMsgIdRef.current ?? nextId();
        userMsgIdRef.current = id;
        setIsSpeaking(true);
        setPhase("hearing");
        upsertMessage(
          id,
          "user",
          joinTranscript(committedSttRef.current, sttLiveRef.current),
          true
        );
        return;
      }
      if (payload.type === "final") {
        const text = (payload.text || "").trim();
        if (!text) return;
        committedSttRef.current = joinTranscript(committedSttRef.current, text);
        sttLiveRef.current = "";
        setSttText(committedSttRef.current);
        setSttPartial(false);
        if (busyRef.current || pausedRef.current) return;
        const id = userMsgIdRef.current ?? nextId();
        userMsgIdRef.current = id;
        upsertMessage(id, "user", committedSttRef.current, true);
        if (finalTimerRef.current) window.clearTimeout(finalTimerRef.current);
        if (asrGateStartedAtRef.current == null) {
          asrGateStartedAtRef.current = performance.now();
        }
        finalTimerRef.current = window.setTimeout(
          flushFinalTranscript,
          FINAL_FLUSH_MS
        );
      }
    },
    [cancelEndpoint, flushFinalTranscript, upsertMessage]
  );

  const connect = useCallback(async () => {
    if (status === "connecting" || status === "connected") return;

    closedRef.current = false;
    setStatus("connecting");
    setPhase("connecting");
    setError(null);
    setMessages([]);
    setSttText("");
    setSttPartial(false);
    setMicLoud(false);

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error(
          "当前页面无法访问麦克风，请使用 HTTPS 或 localhost 访问"
        );
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      mediaStreamRef.current = stream;

      const bootstrap = await fetch(`${API_BASE}/free-coach/bootstrap`, {
        method: "POST",
      });
      if (!bootstrap.ok) {
        let detail = bootstrap.statusText;
        try {
          const payload = await bootstrap.json();
          detail = payload.error ?? payload.detail ?? detail;
        } catch {
          // ignore
        }
        throw new Error(detail);
      }

      const session = (await bootstrap.json()) as {
        token: string;
        conversation_id: string;
        opening_text?: string;
      };
      tokenRef.current = session.token;
      conversationIdRef.current = session.conversation_id;

      const ws = new WebSocket(transcribeSocketUrl());
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => {
          reject(new Error("Amazon Transcribe 连接超时"));
        }, 15000);
        ws.onopen = () => {
          /* wait for ready event */
        };
        ws.onerror = () => {
          window.clearTimeout(timer);
          reject(new Error("无法连接语音识别服务"));
        };
        ws.onmessage = (event) => {
          if (typeof event.data !== "string") return;
          try {
            const payload = JSON.parse(event.data) as {
              type: string;
              message?: string;
              text?: string;
            };
            if (payload.type === "ready") {
              window.clearTimeout(timer);
              resolve();
              return;
            }
            if (payload.type === "error") {
              window.clearTimeout(timer);
              reject(new Error(payload.message || "语音识别失败"));
              return;
            }
            handleTranscript(payload);
          } catch {
            // ignore
          }
        };
      });

      ws.onmessage = (event) => {
        if (typeof event.data !== "string") return;
        try {
          handleTranscript(JSON.parse(event.data));
        } catch {
          // ignore
        }
      };
      ws.onclose = () => {
        if (!closedRef.current) {
          setStatus("disconnected");
          setError("语音识别连接已断开");
        }
      };

      const capture = await createMicCapture(stream, (pcm) => {
        if (ws.readyState !== WebSocket.OPEN) return;

        const rms = pcmRms(pcm);
        const now = Date.now();
        const muted = pausedRef.current || now < unmuteAtRef.current;
        const floor = noiseFloorRef.current;
        if (rms < floor * 2.2) {
          noiseFloorRef.current = floor * 0.97 + rms * 0.03;
        }
        const threshold = Math.min(
          0.045,
          Math.max(0.01, noiseFloorRef.current * 3.4 + 0.006)
        );
        const loud = !muted && rms >= threshold;
        if (micLoudRef.current !== loud) {
          micLoudRef.current = loud;
          setMicLoud(loud);
        }

        if (muted || !loud) {
          ws.send(new Uint8Array(pcm.byteLength));
          if (!muted && (sttLiveRef.current.trim() || committedSttRef.current.trim())) {
            scheduleEndpoint();
          }
          return;
        }

        cancelEndpoint();
        asrGateStartedAtRef.current = null;
        if (finalTimerRef.current) {
          window.clearTimeout(finalTimerRef.current);
          finalTimerRef.current = null;
        }
        ws.send(pcm);
      });
      captureStopRef.current = capture.stop;

      if (session.opening_text) {
        pausedRef.current = true;
      }
      setStatus("connected");

      if (session.opening_text) {
        const openingId = nextId();
        upsertMessage(openingId, "assistant", session.opening_text, false);
        setPhase("speaking");
        const { sentences, rest } = drainSentences(session.opening_text);
        for (const sentence of sentences) {
          void speakText(sentence);
        }
        const leftover = rest.trim();
        if (leftover) void speakText(leftover);
        await speakChainRef.current;
        if (!playingRef.current && !closedRef.current) {
          pausedRef.current = false;
          unmuteAtRef.current = Date.now() + POST_TTS_HOLD_MS;
          setPhase("listening");
        }
      } else {
        setPhase("listening");
      }
    } catch (err) {
      cleanup();
      setStatus("error");
      setError(err instanceof Error ? err.message : "连接失败");
    }
  }, [cancelEndpoint, cleanup, handleTranscript, scheduleEndpoint, speakText, status, upsertMessage]);

  const disconnect = useCallback(() => {
    cleanup();
    setStatus("idle");
  }, [cleanup]);

  const sendTypedMessage = useCallback(
    (text: string) => {
      if (status !== "connected") return;
      const cleaned = text.trim();
      if (!cleaned) return;
      const id = nextId();
      upsertMessage(id, "user", cleaned, false);
      void sendToCoach(cleaned);
    },
    [sendToCoach, status, upsertMessage]
  );

  return {
    status,
    phase,
    phaseLabel: phaseLabel(phase),
    messages,
    error,
    isSpeaking: isSpeaking || phase === "hearing",
    sttText,
    sttPartial,
    micLoud,
    connect,
    disconnect,
    sendTypedMessage,
  };
}
