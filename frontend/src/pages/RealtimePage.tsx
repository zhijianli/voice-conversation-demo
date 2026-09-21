import { useEffect } from "react";
import { VoiceChat } from "../components/VoiceChat";
import { useRealtime } from "../hooks/useRealtime";

export function RealtimeVoiceContent() {
  const { status, messages, error, isSpeaking, connect, disconnect } =
    useRealtime();

  useEffect(() => {
    document.title = "OpenAI Realtime · 端到端";
  }, []);

  return (
    <VoiceChat
      status={status}
      messages={messages}
      error={error}
      isSpeaking={isSpeaking}
      onConnect={() => connect(true)}
      onDisconnect={disconnect}
    />
  );
}
