import { useState } from "react";
import { VoiceChat } from "./components/VoiceChat";
import { useRealtime } from "./hooks/useRealtime";

export default function App() {
  const { status, messages, error, isSpeaking, connect, disconnect } =
    useRealtime();
  const [useLangfuse, setUseLangfuse] = useState(true);

  return (
    <div className="app">
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
