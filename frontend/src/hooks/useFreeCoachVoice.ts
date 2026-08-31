import { useCallback, useEffect, useRef, useState } from "react";
import type { ConnectionStatus, Message, RoundLatency } from "../types";
import { OPENING_AUDIO, OPENING_TEXT } from "../lib/freeCoach";
import {
  API_BASE,
  createMicCapture,
  DEFAULT_MINIMAX_VOICE_ID,
  drainSentences,
  endpointFlushMs,
  FLUSH_MAX_MS,
  FLUSH_MIC_HOLD_MS,
  isCoachTurnBusy,
  readSseStream,
  transcribeSocketUrl,
  pcmRms,
  type MinimaxVoiceId,
  type VoiceLanguage,
} from "../lib/voice";

const POST_TTS_HOLD_MS = 400;

function waitMs(ms: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

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

function addsNewSpeech(committed: string, incoming: string): boolean {
  const a = committed.trim();
  const b = incoming.trim();
  if (!b) return false;
  if (!a) return true;
  return joinTranscript(a, b) !== a;
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

export function useFreeCoachVoice(
  language: VoiceLanguage = "zh",
  voiceId: MinimaxVoiceId = DEFAULT_MINIMAX_VOICE_ID
) {
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
  const unmuteAtRef = useRef(0);
  const noiseFloorRef = useRef(0.008);
  const micLoudRef = useRef(false);
  const asrGateStartedAtRef = useRef<number | null>(null);
  const flushWindowStartedAtRef = useRef(0);
  const lastUserTextRef = useRef("");
  const lastUserIdRef = useRef<string | null>(null);
  const thinkingOpenRef = useRef(false);
  const connectionReadyRef = useRef(false);
  const transcribeReadyRef = useRef(false);
  const languageRef = useRef<VoiceLanguage>(language);
  languageRef.current = language;
  const voiceIdRef = useRef<MinimaxVoiceId>(voiceId);
  voiceIdRef.current = voiceId;

  useEffect(() => {
    void fetch(OPENING_AUDIO[language]);
  }, [language]);

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
    flushWindowStartedAtRef.current = 0;
    lastUserTextRef.current = "";
    lastUserIdRef.current = null;
    thinkingOpenRef.current = false;
    connectionReadyRef.current = false;
    transcribeReadyRef.current = false;
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
    setIsSpeaking(false);
    if (busyRef.current || closedRef.current) return;
    if (!connectionReadyRef.current) {
      setPhase("connecting");
      return;
    }
    pausedRef.current = false;
    unmuteAtRef.current = Date.now() + POST_TTS_HOLD_MS;
    setPhase("listening");
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

  const enqueuePcmStream = useCallback(
    async (
      response: Response,
      sampleRate: number,
      onFirstChunk?: () => void
    ) => {
      if (closedRef.current) return;
      const body = response.body;
      if (!body) throw new Error("服务器未返回音频流");

      const ctx = playbackCtxRef.current ?? new AudioContext();
      playbackCtxRef.current = ctx;
      await ctx.resume();

      const reader = body.getReader();
      // Prefetch so WAN jitter does not underrun 40ms slices.
      const prerollBytes = Math.max(2, Math.round(sampleRate * 0.28) * 2);
      const minChunkBytes = Math.max(2, Math.round(sampleRate * 0.12) * 2);
      let leftover = new Uint8Array(0);
      let started = false;

      const schedule = (pcm: Int16Array) => {
        if (closedRef.current || !pcm.length) return;
        const buffer = ctx.createBuffer(1, pcm.length, sampleRate);
        const channel = buffer.getChannelData(0);
        for (let i = 0; i < pcm.length; i += 1) {
          channel[i] = pcm[i] / 32768;
        }
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
        if (!started) {
          started = true;
          onFirstChunk?.();
        }
        source.onended = () => {
          playbackSourcesRef.current = playbackSourcesRef.current.filter(
            (item) => item !== source
          );
          finishSpeakingIfIdle();
        };
      };

      const takeFrames = (flushAll: boolean) => {
        const total = leftover.length - (leftover.length % 2);
        if (total < 2) return;
        if (!flushAll) {
          if (!started && total < prerollBytes) return;
          const lead = playbackEndAtRef.current - ctx.currentTime;
          if (started && total < minChunkBytes && lead > 0.08) return;
        }
        const copy = leftover.slice(0, total);
        leftover = leftover.slice(total);
        schedule(
          new Int16Array(copy.buffer, copy.byteOffset, copy.byteLength / 2)
        );
      };

      let timedOut = false;
      const firstChunkTimer = window.setTimeout(() => {
        timedOut = true;
        void reader.cancel().catch(() => undefined);
      }, 12000);

      try {
        while (!closedRef.current) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!value || !value.length) continue;
          const merged = new Uint8Array(leftover.length + value.length);
          merged.set(leftover);
          merged.set(value, leftover.length);
          leftover = merged;
          takeFrames(false);
          if (started) window.clearTimeout(firstChunkTimer);
        }
        takeFrames(true);
        if (!started && leftover.length >= 2) takeFrames(true);
        if (!started) {
          throw new Error(timedOut ? "语音合成超时" : "MiniMax 未返回音频");
        }
      } finally {
        window.clearTimeout(firstChunkTimer);
        try {
          reader.releaseLock();
        } catch {
          // already released
        }
      }
    },
    [finishSpeakingIfIdle]
  );

  const speakText = useCallback(
    (text: string) => {
      const cleaned = text.trim();
      if (!cleaned || closedRef.current) return speakChainRef.current;

      let settleFirst: (() => void) | null = null;
      let failFirst: ((err: Error) => void) | null = null;
      const firstAudio = new Promise<void>((resolve, reject) => {
        settleFirst = resolve;
        failFirst = reject;
      });
      firstAudio.catch(() => undefined);

      const pending = fetch(`${API_BASE}/free-coach/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: cleaned,
          language: languageRef.current,
          voice_id: voiceIdRef.current,
        }),
      });

      ttsInFlightRef.current += 1;
      speakChainRef.current = speakChainRef.current
        .then(async () => {
          if (closedRef.current) return;
          const response = await pending;
          if (!response.ok) {
            let detail = response.statusText;
            try {
              const payload = await response.json();
              detail = payload.error ?? payload.detail ?? detail;
            } catch {
              // ignore
            }
            throw new Error(String(detail));
          }
          const format = (response.headers.get("x-audio-format") || "").toLowerCase();
          if (format === "pcm_s16le") {
            const sampleRate = Number(
              response.headers.get("x-sample-rate") || 16000
            );
            await enqueuePcmStream(response, sampleRate, () => settleFirst?.());
          } else {
            await enqueueAudio(await response.blob());
            settleFirst?.();
          }
        })
        .catch((err) => {
          const error = err instanceof Error ? err : new Error("语音合成失败");
          failFirst?.(error);
          if (!closedRef.current) setError(error.message);
        })
        .finally(() => {
          settleFirst?.();
          ttsInFlightRef.current = Math.max(0, ttsInFlightRef.current - 1);
          finishSpeakingIfIdle();
        });

      return firstAudio;
    },
    [enqueueAudio, enqueuePcmStream, finishSpeakingIfIdle]
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
      thinkingOpenRef.current = true;
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
        thinkingOpenRef.current = false;
        pausedRef.current = true;
        userMsgIdRef.current = null;
        if (firstSentenceAt == null) {
          firstSentenceAt = performance.now();
          upsertMessage(assistantId, "assistant", draft, true, {
            asrMs,
            llmMs: firstSentenceAt - llmStarted,
            ttsMs: null,
            totalMs: null,
            phase: "tts",
          });
          const ttsStarted = performance.now();
          void speakText(sentence).then(() => {
            if (ttsFirstMs == null) ttsFirstMs = performance.now() - ttsStarted;
          });
        } else {
          void speakText(sentence);
        }
      };

      try {
        let lastError: Error | null = null;
        for (let attempt = 0; attempt < 6; attempt += 1) {
          if (controller.signal.aborted || closedRef.current) return;
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
              throw new Error(String(detail));
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
            lastError = null;
            break;
          } catch (err) {
            if (controller.signal.aborted) return;
            const message =
              err instanceof Error ? err.message : String(err);
            if (isCoachTurnBusy(message) && attempt < 5) {
              await waitMs(350 * (attempt + 1));
              continue;
            }
            lastError =
              err instanceof Error ? err : new Error(message);
            break;
          }
        }
        if (lastError) throw lastError;

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
        if (abortRef.current === controller) {
          thinkingOpenRef.current = false;
          busyRef.current = false;
          abortRef.current = null;
          assistantMsgIdRef.current = null;
        }
      }
    },
    [speakText, upsertMessage]
  );

  const flushFinalTranscript = useCallback(() => {
    if (finalTimerRef.current) {
      window.clearTimeout(finalTimerRef.current);
      finalTimerRef.current = null;
    }
    if (closedRef.current || busyRef.current) {
      committedSttRef.current = "";
      sttLiveRef.current = "";
      return;
    }
    const text = joinTranscript(committedSttRef.current, sttLiveRef.current);
    committedSttRef.current = "";
    sttLiveRef.current = "";
    if (!text) return;
    const userId = userMsgIdRef.current ?? nextId();
    userMsgIdRef.current = userId;
    lastUserTextRef.current = text;
    lastUserIdRef.current = userId;
    setSttText("");
    setSttPartial(false);
    const asrMs = asrGateStartedAtRef.current
      ? performance.now() - asrGateStartedAtRef.current
      : null;
    asrGateStartedAtRef.current = null;
    upsertMessage(userId, "user", text, false);
    void sendToCoach(text, asrMs);
  }, [sendToCoach, upsertMessage]);

  const armFinalFlush = useCallback(
    (delayMs: number) => {
      if (finalTimerRef.current) {
        window.clearTimeout(finalTimerRef.current);
      }
      finalTimerRef.current = window.setTimeout(() => {
        finalTimerRef.current = null;
        const waited = Date.now() - flushWindowStartedAtRef.current;
        if (micLoudRef.current && waited < FLUSH_MAX_MS) {
          armFinalFlush(FLUSH_MIC_HOLD_MS);
          return;
        }
        flushFinalTranscript();
      }, delayMs);
    },
    [flushFinalTranscript]
  );

  const interruptThinking = useCallback(() => {
    if (!thinkingOpenRef.current || playingRef.current || pausedRef.current) {
      return false;
    }
    thinkingOpenRef.current = false;
    abortRef.current?.abort();
    busyRef.current = false;
    const assistantId = assistantMsgIdRef.current;
    assistantMsgIdRef.current = null;
    if (assistantId) {
      setMessages((prev) => prev.filter((item) => item.id !== assistantId));
    }
    return true;
  }, []);

  const sttHoldActive = () =>
    pausedRef.current || Date.now() < unmuteAtRef.current;

  const handleTranscript = useCallback(
    (payload: { type: string; text?: string; message?: string }) => {
      if (payload.type === "error") {
        setError(payload.message || "语音识别出错");
        return;
      }
      if (sttHoldActive()) return;

      if (thinkingOpenRef.current) {
        if (payload.type !== "partial" && payload.type !== "final") return;
        const incoming = (payload.text || "").trim();
        if (!addsNewSpeech(lastUserTextRef.current, incoming)) return;
        if (!interruptThinking()) return;
        committedSttRef.current = lastUserTextRef.current;
        userMsgIdRef.current = lastUserIdRef.current;
      }

      if (payload.type === "partial") {
        const text = (payload.text || "").trim();
        if (finalTimerRef.current) {
          window.clearTimeout(finalTimerRef.current);
          finalTimerRef.current = null;
        }
        asrGateStartedAtRef.current = null;
        if (text) {
          sttLiveRef.current = text;
          setSttText(joinTranscript(committedSttRef.current, text));
          setSttPartial(true);
        }
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
        const id = userMsgIdRef.current ?? nextId();
        userMsgIdRef.current = id;
        upsertMessage(id, "user", committedSttRef.current, true);
        if (asrGateStartedAtRef.current == null) {
          asrGateStartedAtRef.current = performance.now();
        }
        flushWindowStartedAtRef.current = Date.now();
        armFinalFlush(
          endpointFlushMs(committedSttRef.current, languageRef.current)
        );
      }
    },
    [armFinalFlush, interruptThinking, upsertMessage]
  );

  const connect = useCallback(async () => {
    if (status === "connecting" || status === "connected") return;

    closedRef.current = false;
    connectionReadyRef.current = false;
    transcribeReadyRef.current = false;
    pausedRef.current = true;
    playbackEndAtRef.current = 0;
    speakChainRef.current = Promise.resolve();
    setError(null);
    setMessages([]);
    setSttText("");
    setSttPartial(false);
    setMicLoud(false);

    const language = languageRef.current;
    const openingText = OPENING_TEXT[language];
    upsertMessage(nextId(), "assistant", openingText, false);
    setStatus("connected");
    setPhase("speaking");

    const playbackCtx = playbackCtxRef.current ?? new AudioContext();
    playbackCtxRef.current = playbackCtx;
    void playbackCtx.resume();

    const playOpening = async () => {
      const useCachedOpening =
        language === "en" || voiceIdRef.current === DEFAULT_MINIMAX_VOICE_ID;
      try {
        if (!useCachedOpening) {
          throw new Error("use live tts");
        }
        const response = await fetch(OPENING_AUDIO[language]);
        if (!response.ok) {
          throw new Error("开场语音加载失败");
        }
        const blob = await response.blob();
        ttsInFlightRef.current += 1;
        speakChainRef.current = speakChainRef.current
          .then(async () => {
            if (closedRef.current) return;
            await enqueueAudio(blob);
          })
          .finally(() => {
            ttsInFlightRef.current = Math.max(0, ttsInFlightRef.current - 1);
            finishSpeakingIfIdle();
          });
        await speakChainRef.current;
      } catch {
        await speakText(openingText);
        await speakChainRef.current;
      }
      const ctx = playbackCtxRef.current;
      if (!ctx || closedRef.current) return;
      const remainMs = (playbackEndAtRef.current - ctx.currentTime) * 1000;
      if (remainMs > 0) await waitMs(remainMs);
    };

    const setupSession = async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error(
          "当前页面无法访问麦克风，请使用 HTTPS 或 localhost 访问"
        );
      }

      const [stream, bootstrap] = await Promise.all([
        navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        }),
        fetch(`${API_BASE}/free-coach/bootstrap`, {
          method: "POST",
        }),
      ]);
      if (closedRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      mediaStreamRef.current = stream;

      if (!bootstrap.ok) {
        let detail = bootstrap.statusText;
        try {
          const payload = await bootstrap.json();
          detail = String(payload.error ?? payload.detail ?? detail);
        } catch {
          // ignore
        }
        if (!detail || detail === "Internal Server Error") {
          detail =
            "后端没有响应。请确认本机已启动 uvicorn（127.0.0.1:8000），然后刷新再试。";
        }
        throw new Error(detail);
      }

      const session = (await bootstrap.json()) as {
        token: string;
        conversation_id: string;
      };
      tokenRef.current = session.token;
      conversationIdRef.current = session.conversation_id;

      const capture = await createMicCapture(stream, (pcm) => {
        const ws = wsRef.current;
        if (
          !ws ||
          ws.readyState !== WebSocket.OPEN ||
          !transcribeReadyRef.current
        ) {
          return;
        }

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
          return;
        }

        ws.send(pcm);
      });
      if (closedRef.current) {
        capture.stop();
        return;
      }
      captureStopRef.current = capture.stop;

      const openTranscribe = () =>
        new Promise<void>((resolve, reject) => {
          if (closedRef.current) {
            resolve();
            return;
          }
          const ws = new WebSocket(transcribeSocketUrl(language));
          ws.binaryType = "arraybuffer";
          wsRef.current = ws;
          let settled = false;
          let timer = 0;
          const fail = (message: string) => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timer);
            reject(new Error(message));
          };
          timer = window.setTimeout(() => {
            fail("Amazon Transcribe 连接超时");
            try {
              ws.close();
            } catch {
              // ignore
            }
          }, 20000);
          ws.onerror = () => {
            /* Chromium 会在 close 前先触发 error，真正原因看 onclose / ready */
          };
          ws.onclose = () => fail("语音识别连接已断开");
          ws.onmessage = (event) => {
            if (typeof event.data !== "string") return;
            try {
              const payload = JSON.parse(event.data) as {
                type: string;
                message?: string;
                text?: string;
              };
              if (payload.type === "ready") {
                if (settled) return;
                settled = true;
                window.clearTimeout(timer);
                transcribeReadyRef.current = true;
                ws.onclose = () => {
                  if (closedRef.current) return;
                  transcribeReadyRef.current = false;
                  connectionReadyRef.current = false;
                  setError("语音识别连接已断开，正在重连…");
                  window.setTimeout(() => {
                    if (closedRef.current) return;
                    void openTranscribe()
                      .then(() => {
                        if (closedRef.current) return;
                        connectionReadyRef.current = true;
                        setError(null);
                      })
                      .catch((err) => {
                        if (!closedRef.current) {
                          setError(
                            err instanceof Error
                              ? err.message
                              : "无法连接语音识别服务"
                          );
                        }
                      });
                  }, 600);
                };
                ws.onmessage = (messageEvent) => {
                  if (typeof messageEvent.data !== "string") return;
                  try {
                    handleTranscript(JSON.parse(messageEvent.data));
                  } catch {
                    // ignore
                  }
                };
                resolve();
                return;
              }
              if (payload.type === "error") {
                fail(payload.message || "语音识别失败");
                return;
              }
              handleTranscript(payload);
            } catch {
              // ignore
            }
          };
        });

      try {
        await openTranscribe();
        if (!closedRef.current) connectionReadyRef.current = true;
      } catch {
        if (!closedRef.current) {
          window.setTimeout(() => {
            if (closedRef.current) return;
            void openTranscribe()
              .then(() => {
                if (closedRef.current) return;
                connectionReadyRef.current = true;
                setError(null);
                if (!playingRef.current && !busyRef.current) {
                  pausedRef.current = false;
                  unmuteAtRef.current = Date.now() + POST_TTS_HOLD_MS;
                  setPhase("listening");
                }
              })
              .catch((err) => {
                if (!closedRef.current) {
                  setError(
                    err instanceof Error ? err.message : "无法连接语音识别服务"
                  );
                }
              });
          }, 800);
        }
      }
    };

    try {
      await Promise.all([playOpening(), setupSession()]);
      if (closedRef.current) return;
      playingRef.current = false;
      setIsSpeaking(false);
      if (connectionReadyRef.current) {
        pausedRef.current = false;
        unmuteAtRef.current = Date.now() + POST_TTS_HOLD_MS;
        setPhase("listening");
      } else {
        setPhase("connecting");
      }
    } catch (err) {
      cleanup();
      setStatus("error");
      setError(err instanceof Error ? err.message : "连接失败");
    }
  }, [cleanup, enqueueAudio, finishSpeakingIfIdle, handleTranscript, speakText, status, upsertMessage]);

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
