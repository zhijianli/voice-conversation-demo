import { useEffect, useState, type FormEvent } from "react";
import { SchemeOverview } from "../components/SchemeOverview";
import { SchemeVoiceSettings } from "../components/SchemeVoiceSettings";
import { VoiceChat } from "../components/VoiceChat";
import { useFreeCoachVoice } from "../hooks/useFreeCoachVoice";
import { getScheme } from "../lib/schemes";
import type { MinimaxVoiceId, VoiceLanguage } from "../lib/voice";
import {
  DEFAULT_MINIMAX_VOICE_ID,
  isMinimaxVoiceId,
  MINIMAX_VOICE_STORAGE_KEY,
} from "../lib/voice";

const COPY: Record<
  VoiceLanguage,
  { emptyHint: string; emptySubHint: string; placeholder: string }
> = {
  en: {
    emptyHint: "点击「开始对话」后对着麦克风说话，也可以在下方打字发送。",
    emptySubHint: "识别由 Deepgram 完成，对话逻辑走 volo，回复由 MiniMax 女声朗读。",
    placeholder: "也可以打字发给教练…",
  },
  zh: {
    emptyHint: "点击「开始对话」后对着麦克风说中文，也可以在下方打字发送。",
    emptySubHint: "识别由 Deepgram 完成，对话逻辑走 volo，回复由 MiniMax 女声朗读。",
    placeholder: "也可以打字发给教练…",
  },
};

function readStoredVoice(): MinimaxVoiceId {
  try {
    const stored = localStorage.getItem(MINIMAX_VOICE_STORAGE_KEY) || "";
    if (isMinimaxVoiceId(stored)) return stored;
  } catch {
    // ignore
  }
  return DEFAULT_MINIMAX_VOICE_ID;
}

export function LiveKitVoiceContent() {
  const scheme = getScheme("livekit");
  const [language, setLanguage] = useState<VoiceLanguage>("zh");
  const [voiceId, setVoiceId] = useState<MinimaxVoiceId>(readStoredVoice);
  const {
    status,
    phaseLabel,
    messages,
    error,
    isSpeaking,
    connect,
    disconnect,
    sendTypedMessage,
    micLoud,
  } = useFreeCoachVoice(language, voiceId, "livekit");
  const [draft, setDraft] = useState("");
  const copy = COPY[language];
  const settingsLocked = status === "connected" || status === "connecting";

  useEffect(() => {
    document.title = "LiveKit + volo · 自主拼接";
  }, []);

  useEffect(() => {
    if (language !== "zh") return;
    try {
      localStorage.setItem(MINIMAX_VOICE_STORAGE_KEY, voiceId);
    } catch {
      // ignore
    }
  }, [language, voiceId]);

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    void sendTypedMessage(text);
  };

  if (!scheme) return null;

  return (
    <div className="scheme-panel">
      <SchemeOverview
        scheme={scheme}
        settings={
          <SchemeVoiceSettings
            language={language}
            onLanguageChange={setLanguage}
            voiceId={voiceId}
            onVoiceChange={setVoiceId}
            languageDisabled={settingsLocked}
          />
        }
      />
      <VoiceChat
        emptyHint={copy.emptyHint}
        emptySubHint={copy.emptySubHint}
        assistantLabel="教练"
        status={status}
        messages={messages}
        error={error}
        isSpeaking={isSpeaking}
        activityLabel={phaseLabel}
        onConnect={connect}
        onDisconnect={disconnect}
        micLoud={micLoud}
        footerExtra={
          <form className="typed-input-row" onSubmit={onSubmit}>
            <input
              type="text"
              value={draft}
              placeholder={copy.placeholder}
              disabled={status !== "connected"}
              onChange={(event) => setDraft(event.target.value)}
            />
            <button type="submit" className="btn btn-secondary" disabled={status !== "connected"}>
              发送
            </button>
          </form>
        }
      />
    </div>
  );
}
