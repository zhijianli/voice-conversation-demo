import { useEffect, useRef, type ReactNode } from "react";
import type { ConnectionStatus, Message, RoundLatency } from "../types";
import type { MinimaxVoiceId, VoiceLanguage } from "../lib/voice";
import { MINIMAX_VOICES } from "../lib/voice";

interface VoiceChatProps {
  title?: string;
  subtitle?: string;
  emptyHint?: string;
  emptySubHint?: string;
  assistantLabel?: string;
  status: ConnectionStatus;
  messages: Message[];
  error: string | null;
  isSpeaking: boolean;
  activityLabel?: string;
  useLangfuse?: boolean;
  onUseLangfuseChange?: (value: boolean) => void;
  onConnect: () => void;
  onDisconnect: () => void;
  footerExtra?: ReactNode;
  micLoud?: boolean;
  language?: VoiceLanguage;
  onLanguageChange?: (language: VoiceLanguage) => void;
  voiceId?: MinimaxVoiceId;
  onVoiceChange?: (voiceId: MinimaxVoiceId) => void;
}

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  idle: "未连接",
  connecting: "连接中…",
  connected: "对话中",
  disconnected: "已断开",
  error: "连接错误",
};

function formatMs(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} 秒`;
}

function formatMessageLatency(latency: RoundLatency): string {
  const parts: string[] = [];
  if (latency.asrMs != null) parts.push(`ASR 收口 ${formatMs(latency.asrMs)}`);
  if (latency.llmMs != null) parts.push(`首句生成 ${formatMs(latency.llmMs)}`);
  if (latency.ttsMs != null) parts.push(`首句 TTS ${formatMs(latency.ttsMs)}`);
  if (latency.totalMs != null) {
    // ElevenLabs 等只有「距用户说完」时，文案更直观
    const onlyTotal =
      latency.asrMs == null && latency.llmMs == null && latency.ttsMs == null;
    parts.push(
      onlyTotal
        ? `距你说完 ${formatMs(latency.totalMs)}`
        : `听到声音 ${formatMs(latency.totalMs)}`
    );
  }
  return parts.join(" · ");
}

export function VoiceChat({
  title = "Realtime 语音对话",
  subtitle = "基于 OpenAI Realtime API · WebRTC",
  emptyHint = "点击「开始对话」后，直接对着麦克风说话即可。",
  emptySubHint = "AI 会通过扬声器回复，对话内容会显示在这里。",
  assistantLabel = "AI",
  status,
  messages,
  error,
  isSpeaking,
  activityLabel,
  useLangfuse = false,
  onUseLangfuseChange,
  onConnect,
  onDisconnect,
  footerExtra,
  micLoud = false,
  language = "zh",
  onLanguageChange,
  voiceId,
  onVoiceChange,
}: VoiceChatProps) {
  const isConnected = status === "connected";
  const isBusy = status === "connecting";
  const toggleDisabled = isConnected || isBusy;
  const panelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    panel.scrollTo({ top: panel.scrollHeight, behavior: "smooth" });
  }, [messages]);

  return (
    <div className="voice-chat">
      <header className="header">
        <div>
          <h1>{title}</h1>
          <p className="subtitle">{subtitle}</p>
        </div>
        <div className="header-actions">
          {onLanguageChange ? (
            <div
              className={`language-switch ${toggleDisabled ? "disabled" : ""}`}
              role="group"
              aria-label="识别与朗读语言"
            >
              <button
                type="button"
                className={language === "zh" ? "active" : ""}
                disabled={toggleDisabled}
                onClick={() => onLanguageChange("zh")}
              >
                中文
              </button>
              <button
                type="button"
                className={language === "en" ? "active" : ""}
                disabled={toggleDisabled}
                onClick={() => onLanguageChange("en")}
              >
                English
              </button>
            </div>
          ) : null}
          {onUseLangfuseChange ? (
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
          ) : null}
          <div className={`status-badge status-${status}`}>
            <span className="status-dot" />
            {STATUS_LABEL[status]}
          </div>
        </div>
      </header>

      {onVoiceChange && language === "zh" ? (
        <div className="voice-picker" role="group" aria-label="教练音色">
          <span className="voice-picker-label">音色</span>
          <div className="voice-picker-options">
            {MINIMAX_VOICES.map((voice) => (
              <button
                key={voice.id}
                type="button"
                className={voiceId === voice.id ? "active" : ""}
                aria-pressed={voiceId === voice.id}
                onClick={() => onVoiceChange(voice.id)}
              >
                {voice.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <section className="transcript-panel" ref={panelRef}>
        {messages.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">🎙️</div>
            <p>{emptyHint}</p>
            <p className="hint">{emptySubHint}</p>
          </div>
        ) : (
          <ul className="message-list">
            {messages.map((msg) => (
              <li key={msg.id} className={`message message-${msg.role}`}>
                <span className="message-role">
                  {msg.role === "user" ? "你" : assistantLabel}
                </span>
                <p className="message-text">
                  {msg.text}
                  {msg.isPartial && <span className="cursor">▍</span>}
                </p>
                {msg.role === "assistant" && msg.latency ? (
                  <p className="message-latency">
                    {formatMessageLatency(msg.latency)}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {error && <div className="error-banner">{error}</div>}

      <footer className="controls">
        {isConnected && (
          <div className={`mic-indicator ${isSpeaking || micLoud ? "active" : ""}`}>
            <span className="mic-ring" />
            <span>
              {activityLabel || (isSpeaking ? "正在聆听…" : "等待你说话")}
            </span>
          </div>
        )}

        {footerExtra}

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
