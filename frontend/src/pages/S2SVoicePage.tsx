import { VoiceChat } from "../components/VoiceChat";
import { useS2SWebSocket, type S2SProvider } from "../hooks/useS2SWebSocket";
import { getScheme, type SchemeId } from "../lib/schemes";

function providerFromScheme(schemeId: SchemeId): S2SProvider | null {
  if (schemeId === "bailian" || schemeId === "gemini-live" || schemeId === "doubao") {
    return schemeId === "gemini-live" ? "gemini" : schemeId;
  }
  if (schemeId === "deepgram") return "deepgram";
  return null;
}

export function S2SVoiceContent({ schemeId }: { schemeId: SchemeId }) {
  const provider = providerFromScheme(schemeId);
  const scheme = getScheme(schemeId);
  const { status, messages, error, isSpeaking, connect, disconnect } = useS2SWebSocket(
    provider ?? "bailian"
  );
  if (!provider || !scheme) return null;

  return (
    <VoiceChat
      emptyHint="点击「开始对话」后，直接对着麦克风说话即可。"
      emptySubHint="AI 会通过扬声器回复，对话内容会显示在这里。"
      status={status}
      messages={messages}
      error={error}
      isSpeaking={isSpeaking}
      onConnect={() => connect(true)}
      onDisconnect={disconnect}
    />
  );
}
