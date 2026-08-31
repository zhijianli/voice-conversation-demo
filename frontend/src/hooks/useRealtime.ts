import { useCallback, useRef, useState } from "react";
import type { ConnectionStatus, Message, RealtimeActions, RealtimeState } from "../types";

let messageCounter = 0;

function nextId() {
  return `msg-${++messageCounter}`;
}

function transcriptFamily(type: string): "output" | "legacy" {
  return type.includes("output_audio_transcript") ? "output" : "legacy";
}

const API_BASE = `${import.meta.env.BASE_URL}api`;

export function useRealtime(): RealtimeState & RealtimeActions {
  const [status, setStatus] = useState<ConnectionStatus>("idle");
  const [messages, setMessages] = useState<Message[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isSpeaking, setIsSpeaking] = useState(false);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const assistantDraftRef = useRef<string>("");
  const assistantMsgIdRef = useRef<string | null>(null);
  const userPendingMsgIdRef = useRef<string | null>(null);
  const transcriptSourceRef = useRef<"output" | "legacy" | null>(null);

  const resetAssistantDraft = useCallback(() => {
    assistantDraftRef.current = "";
    assistantMsgIdRef.current = null;
    transcriptSourceRef.current = null;
  }, []);

  const acceptTranscriptEvent = (type: string) => {
    const family = transcriptFamily(type);
    if (transcriptSourceRef.current && transcriptSourceRef.current !== family) {
      return false;
    }
    transcriptSourceRef.current = family;
    return true;
  };

  const resetUserPending = useCallback(() => {
    userPendingMsgIdRef.current = null;
  }, []);

  const upsertAssistantMessage = useCallback((text: string, isPartial: boolean) => {
    setMessages((prev) => {
      let index = assistantMsgIdRef.current
        ? prev.findIndex((m) => m.id === assistantMsgIdRef.current)
        : -1;

      // Realtime 2.1 可能在同一轮里再次下发 response.created，把 ID 清掉。
      // 此时最后一条未收口的 AI 消息就是正在流式输出的那条，必须原地更新。
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

      const last = prev[prev.length - 1];
      if (last?.role === "assistant" && last.text === text && !last.isPartial && !isPartial) {
        assistantMsgIdRef.current = last.id;
        return prev;
      }

      return [...prev, entry];
    });
  }, []);

  const insertLateUserMessage = useCallback((transcript: string) => {
    setMessages((prev) => {
      const entry: Message = {
        id: nextId(),
        role: "user",
        text: transcript,
      };

      let insertAt = prev.length;
      for (let i = prev.length - 1; i >= 0; i -= 1) {
        if (prev[i].role === "assistant") {
          insertAt = i;
          continue;
        }
        break;
      }

      return [...prev.slice(0, insertAt), entry, ...prev.slice(insertAt)];
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
        return;
      }

      insertLateUserMessage(text);
    },
    [insertLateUserMessage, resetUserPending]
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
    assistantDraftRef.current = "";
    assistantMsgIdRef.current = null;
    transcriptSourceRef.current = null;
  }, []);

  const cleanup = useCallback(() => {
    dcRef.current?.close();
    dcRef.current = null;

    pcRef.current?.close();
    pcRef.current = null;

    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;

    if (audioRef.current) {
      audioRef.current.srcObject = null;
      audioRef.current = null;
    }

    resetAssistantDraft();
    resetUserPending();
    setIsSpeaking(false);
  }, [resetAssistantDraft, resetUserPending]);

  const handleServerEvent = useCallback(
    (event: Record<string, unknown>) => {
      const type = event.type as string;

      switch (type) {
        case "response.created":
          // 新的一轮回复才清空草稿。同一轮里重复的 created 不能丢掉正在输出的气泡。
          if (!assistantMsgIdRef.current) {
            assistantDraftRef.current = "";
            transcriptSourceRef.current = null;
          }
          break;

        case "input_audio_buffer.speech_started":
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

        case "conversation.item.input_audio_transcription.completed": {
          const transcript = (event as { transcript?: string }).transcript ?? "";
          completeUserTranscript(transcript);
          break;
        }

        case "response.output_audio_transcript.delta":
        case "response.audio_transcript.delta": {
          if (!acceptTranscriptEvent(type)) break;
          const delta = (event as { delta?: string }).delta ?? "";
          assistantDraftRef.current += delta;
          upsertAssistantMessage(assistantDraftRef.current, true);
          break;
        }

        case "response.output_audio_transcript.done":
        case "response.audio_transcript.done": {
          if (!acceptTranscriptEvent(type)) break;
          const transcript =
            (event as { transcript?: string }).transcript ??
            assistantDraftRef.current;
          if (transcript.trim()) {
            assistantDraftRef.current = transcript;
            upsertAssistantMessage(transcript, false);
          }
          break;
        }

        case "response.done":
          finalizeAssistantMessage();
          break;

        case "error": {
          const message =
            (event as { error?: { message?: string } }).error?.message ??
            "未知错误";
          setError(message);
          break;
        }
      }
    },
    [completeUserTranscript, finalizeAssistantMessage, upsertAssistantMessage]
  );

  const connect = useCallback(async (useLangfuse = false) => {
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

      const pc = new RTCPeerConnection();
      pcRef.current = pc;

      const audio = document.createElement("audio");
      audio.autoplay = true;
      audioRef.current = audio;
      pc.ontrack = (e) => {
        audio.srcObject = e.streams[0];
      };

      pc.addTrack(stream.getTracks()[0]);

      const dc = pc.createDataChannel("oai-events");
      dcRef.current = dc;

      dc.addEventListener("open", () => {
        setStatus("connected");
      });

      dc.addEventListener("message", (e) => {
        try {
          handleServerEvent(JSON.parse(e.data));
        } catch {
          // ignore malformed events
        }
      });

      dc.addEventListener("close", () => {
        setStatus("disconnected");
      });

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const sessionUrl = `${API_BASE}/session?use_langfuse=${useLangfuse}`;
      const response = await fetch(sessionUrl, {
        method: "POST",
        headers: { "Content-Type": "application/sdp" },
        body: offer.sdp,
      });

      if (!response.ok) {
        let detail = response.statusText;
        try {
          const body = await response.json();
          detail = body.detail ?? body.error ?? detail;
        } catch {
          // response is not json
        }
        throw new Error(detail);
      }

      const answerSdp = await response.text();
      await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
    } catch (err) {
      cleanup();
      setStatus("error");
      setError(err instanceof Error ? err.message : "连接失败");
    }
  }, [cleanup, handleServerEvent, status]);

  const disconnect = useCallback(() => {
    cleanup();
    setStatus("idle");
  }, [cleanup]);

  return { status, messages, error, isSpeaking, connect, disconnect };
}
