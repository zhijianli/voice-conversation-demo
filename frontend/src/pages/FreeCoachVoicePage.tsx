import { useEffect, useState, type FormEvent } from "react";
import { PageNav } from "../components/PageNav";
import { VoiceChat } from "../components/VoiceChat";
import { useFreeCoachVoice } from "../hooks/useFreeCoachVoice";
import type { MinimaxVoiceId, VoiceLanguage } from "../lib/voice";
import {
  DEFAULT_MINIMAX_VOICE_ID,
  isMinimaxVoiceId,
  MINIMAX_VOICE_STORAGE_KEY,
  minimaxVoiceLabel,
} from "../lib/voice";

const COPY: Record<
  VoiceLanguage,
  { subtitle: string; emptyHint: string; emptySubHint: string; placeholder: string }
> = {
  en: {
    subtitle:
      "STT Amazon Transcribe (en-US) · TTS Amazon Polly Generative Ruth · EverEcho free-coach",
    emptyHint: "点击「开始对话」后对着麦克风说英语，也可以在下方打字发送。",
    emptySubHint:
      "识别结果会发给 EverEcho free-coach，回复由 Polly 英文 Generative 音色朗读。",
    placeholder: "也可以打字发给教练…",
  },
  zh: {
    subtitle:
      "STT Amazon Transcribe (zh-CN) · TTS MiniMax speech-2.6-turbo · EverEcho free-coach",
    emptyHint: "点击「开始对话」后对着麦克风说中文，也可以在下方打字发送。",
    emptySubHint:
      "识别结果会发给 EverEcho free-coach，回复由 MiniMax 中文音色朗读。",
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

export function FreeCoachVoicePage() {
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
  } = useFreeCoachVoice(language, voiceId);
  const [draft, setDraft] = useState("");
  const copy = COPY[language];
  const subtitle =
    language === "zh"
      ? `${copy.subtitle} · ${minimaxVoiceLabel(voiceId)}`
      : copy.subtitle;

  useEffect(() => {
    document.title = "Free Coach 语音对话";
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(MINIMAX_VOICE_STORAGE_KEY, voiceId);
    } catch {
      // ignore
    }
  }, [voiceId]);

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    sendTypedMessage(draft);
    setDraft("");
  };

  return (
    <div className="app">
      <PageNav />
      <VoiceChat
        title="Free Coach 语音对话"
        subtitle={subtitle}
        emptyHint={copy.emptyHint}
        emptySubHint={copy.emptySubHint}
        assistantLabel="教练"
        status={status}
        messages={messages}
        error={error}
        isSpeaking={isSpeaking}
        activityLabel={status === "connected" ? phaseLabel : undefined}
        micLoud={micLoud}
        language={language}
        onLanguageChange={setLanguage}
        voiceId={voiceId}
        onVoiceChange={setVoiceId}
        onConnect={connect}
        onDisconnect={disconnect}
        footerExtra={
          status === "connected" ? (
            <form className="text-fallback" onSubmit={onSubmit}>
              <input
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder={copy.placeholder}
                maxLength={8000}
              />
              <button type="submit" className="btn btn-secondary" disabled={!draft.trim()}>
                发送
              </button>
            </form>
          ) : null
        }
      />
    </div>
  );
}
