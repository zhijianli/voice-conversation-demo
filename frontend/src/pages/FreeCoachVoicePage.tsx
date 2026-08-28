import { useEffect, useState, type FormEvent } from "react";
import { PageNav } from "../components/PageNav";
import { VoiceChat } from "../components/VoiceChat";
import { useFreeCoachVoice } from "../hooks/useFreeCoachVoice";

export function FreeCoachVoicePage() {
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
  } = useFreeCoachVoice();
  const [draft, setDraft] = useState("");

  useEffect(() => {
    document.title = "Free Coach 语音对话";
  }, []);

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
        subtitle="STT Amazon Transcribe (en-US) · TTS Amazon Polly Generative Ruth · EverEcho free-coach"
        emptyHint="点击「开始对话」后对着麦克风说英语，也可以在下方打字发送。"
        emptySubHint="识别结果会发给 EverEcho free-coach，回复由 Polly 英文 Generative 音色朗读。"
        assistantLabel="教练"
        status={status}
        messages={messages}
        error={error}
        isSpeaking={isSpeaking}
        activityLabel={status === "connected" ? phaseLabel : undefined}
        micLoud={micLoud}
        onConnect={connect}
        onDisconnect={disconnect}
        footerExtra={
          status === "connected" ? (
            <form className="text-fallback" onSubmit={onSubmit}>
              <input
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="也可以打字发给教练…"
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
