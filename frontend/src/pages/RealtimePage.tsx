import { useEffect, useState } from "react";
import { PageNav } from "../components/PageNav";
import { VoiceChat } from "../components/VoiceChat";
import { useRealtime } from "../hooks/useRealtime";

export function RealtimePage() {
  const { status, messages, error, isSpeaking, connect, disconnect } =
    useRealtime();
  const [useLangfuse, setUseLangfuse] = useState(true);

  useEffect(() => {
    document.title = "OpenAI Realtime 语音对话";
  }, []);

  return (
    <div className="app">
      <PageNav />
      <VoiceChat
        status={status}
        messages={messages}
        error={error}
        isSpeaking={isSpeaking}
        useLangfuse={useLangfuse}
        onUseLangfuseChange={setUseLangfuse}
        onConnect={() => connect(useLangfuse)}
        onDisconnect={disconnect}
      />
    </div>
  );
}
