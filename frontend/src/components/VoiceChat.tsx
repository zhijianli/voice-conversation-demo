import type { ConnectionStatus, Message } from "../types";

interface VoiceChatProps {
  status: ConnectionStatus;
  messages: Message[];
  error: string | null;
  isSpeaking: boolean;
  useLangfuse: boolean;
  onUseLangfuseChange: (value: boolean) => void;
  onConnect: () => void;
  onDisconnect: () => void;
}

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  idle: "未连接",
  connecting: "连接中…",
  connected: "对话中",
  disconnected: "已断开",
  error: "连接错误",
};

export function VoiceChat({
  status,
  messages,
  error,
  isSpeaking,
  useLangfuse,
  onUseLangfuseChange,
  onConnect,
  onDisconnect,
}: VoiceChatProps) {
  const isConnected = status === "connected";
  const isBusy = status === "connecting";
  const toggleDisabled = isConnected || isBusy;

  return (
    <div className="voice-chat">
      <header className="header">
        <div>
          <h1>Realtime 语音对话</h1>
          <p className="subtitle">基于 OpenAI Realtime API · WebRTC</p>
        </div>
        <div className="header-actions">
          <label className={`langfuse-toggle ${toggleDisabled ? "disabled" : ""}`}>
            <input
              type="checkbox"
              checked={useLangfuse}
              disabled={toggleDisabled}
              onChange={(e) => onUseLangfuseChange(e.target.checked)}
            />
            <span className="toggle-track" aria-hidden="true">
              <span className="toggle-thumb" />
            </span>
            <span className="toggle-label">
              Langfuse 提示词
              <span className="toggle-hint">constitution + free_coach</span>
            </span>
          </label>
          <div className={`status-badge status-${status}`}>
            <span className="status-dot" />
            {STATUS_LABEL[status]}
          </div>
        </div>
      </header>

      <section className="transcript-panel">
        {messages.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">🎙️</div>
            <p>点击「开始对话」后，直接对着麦克风说话即可。</p>
            <p className="hint">AI 会通过扬声器回复，对话内容会显示在这里。</p>
          </div>
        ) : (
          <ul className="message-list">
            {messages.map((msg) => (
              <li key={msg.id} className={`message message-${msg.role}`}>
                <span className="message-role">
                  {msg.role === "user" ? "你" : "AI"}
                </span>
                <p className="message-text">
                  {msg.text}
                  {msg.isPartial && <span className="cursor">▍</span>}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      {error && <div className="error-banner">{error}</div>}

      <footer className="controls">
        {isConnected && (
          <div className={`mic-indicator ${isSpeaking ? "active" : ""}`}>
            <span className="mic-ring" />
            <span>{isSpeaking ? "正在聆听…" : "等待你说话"}</span>
          </div>
        )}

        <div className="button-group">
          {!isConnected ? (
            <button
              className="btn btn-primary"
              onClick={onConnect}
              disabled={isBusy}
            >
              {isBusy ? "连接中…" : "开始对话"}
            </button>
          ) : (
            <button className="btn btn-danger" onClick={onDisconnect}>
              结束对话
            </button>
          )}
        </div>
      </footer>
    </div>
  );
}
