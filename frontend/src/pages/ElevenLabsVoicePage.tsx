import { ConversationProvider } from "@elevenlabs/react";
import { useEffect, useState, type FormEvent } from "react";
import { SchemeOverview } from "../components/SchemeOverview";
import { SchemeVoiceSettings } from "../components/SchemeVoiceSettings";
import { VoiceChat } from "../components/VoiceChat";
import { getScheme } from "../lib/schemes";
import {
  useElevenLabsVoice,
  type ElevenLabsPublicConfig,
} from "../hooks/useElevenLabsVoice";
import { OPENING_TEXT } from "../lib/freeCoach";
import type { VoiceLanguage } from "../lib/voice";

const COPY: Record<
  VoiceLanguage,
  { emptyHint: string; emptySubHint: string; placeholder: string }
> = {
  zh: {
    emptyHint:
      "进入页面会预热麦克风权限；点「开始对话」后对着麦克风说中文。语音由 ElevenLabs 处理，教练仍是 Free Coach。",
    emptySubHint: "开场白和 system prompt 以 Free Coach 为准。",
    placeholder: "也可以打字发给教练…",
  },
  en: {
    emptyHint:
      "This page warms up mic permission on load. Click Start, then speak English. ElevenLabs handles voice; Free Coach still answers.",
    emptySubHint: "Opening line and persona stay Free Coach.",
    placeholder: "Or type a message to the coach…",
  },
};

const EL_PRECONNECT_HOSTS = [
  "https://api.elevenlabs.io",
  "https://livekit.rtc.elevenlabs.io",
] as const;

function installElevenLabsPreconnect() {
  const created: HTMLLinkElement[] = [];
  for (const href of EL_PRECONNECT_HOSTS) {
    const existing = document.head.querySelector(
      `link[rel="preconnect"][href="${href}"]`
    );
    if (existing) continue;
    const link = document.createElement("link");
    link.rel = "preconnect";
    link.href = href;
    link.crossOrigin = "anonymous";
    document.head.appendChild(link);
    created.push(link);
  }
  return () => {
    for (const link of created) link.remove();
  };
}

/** 只预热权限，立刻释放麦，避免占着麦拖慢 SDK 正式建连。 */
async function warmMicrophonePermission() {
  if (!navigator.mediaDevices?.getUserMedia) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
    for (const track of stream.getTracks()) {
      track.stop();
    }
  } catch {
    // 用户拒绝或设备不可用时忽略；点「开始对话」时 SDK 会再申请一次
  }
}

function SetupCard({
  config,
  language,
}: {
  config: ElevenLabsPublicConfig | null;
  language: VoiceLanguage;
}) {
  if (config?.agent_configured) return null;
  return (
    <section className="setup-card" aria-label="ElevenLabs Agent 接入说明">
      <h2>先在 ElevenLabs 配好 Agent，这个页面就能开始语音对话</h2>
      <ol>
        <li>在 ElevenLabs Agents 新建 Agent，LLM 选 Custom LLM。</li>
        <li>
          Server URL 填：
          <code>{config?.custom_llm_url || "https://api.volohorizon.com/realtime/api/elevenlabs"}</code>
        </li>
        <li>
          Model ID 填：<code>{config?.custom_llm_model || "free-coach"}</code>
        </li>
        <li>
          First message 填：<code>{OPENING_TEXT[language]}</code>
        </li>
        <li>System prompt 留空或随便写——适配层会忽略，人设仍走 volo free_coach。</li>
        <li>
          把 Agent ID 写入 <code>backend/.env</code> 的 <code>ELEVENLABS_AGENT_ID</code> 后重启后端。
        </li>
      </ol>
      <p className="hint">{config?.system_prompt_note}</p>
    </section>
  );
}

function ElevenLabsVoiceInner() {
  const scheme = getScheme("elevenlabs");
  const [language, setLanguage] = useState<VoiceLanguage>("zh");
  const [draft, setDraft] = useState("");
  const {
    config,
    status,
    messages,
    error,
    isSpeaking,
    activityLabel,
    micLoud,
    connect,
    disconnect,
    sendTypedMessage,
  } = useElevenLabsVoice(language);
  const copy = COPY[language];
  const settingsLocked = status === "connected" || status === "connecting";

  useEffect(() => {
    document.title = "ElevenLabs · 编排平台";
    const removePreconnect = installElevenLabsPreconnect();
    void warmMicrophonePermission();
    return removePreconnect;
  }, []);

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    sendTypedMessage(draft);
    setDraft("");
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
            languageDisabled={settingsLocked}
          />
        }
      />
      <div className="scheme-panel__demo">
        <SetupCard config={config} language={language} />
        <VoiceChat
          emptyHint={copy.emptyHint}
          emptySubHint={copy.emptySubHint}
          assistantLabel="教练"
          status={status}
          messages={messages}
          error={error}
          isSpeaking={isSpeaking}
          activityLabel={status === "connected" ? activityLabel : undefined}
          micLoud={micLoud}
          onConnect={() => {
            void connect();
          }}
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
                <button
                  type="submit"
                  className="btn btn-secondary"
                  disabled={!draft.trim()}
                >
                  发送
                </button>
              </form>
            ) : null
          }
        />
      </div>
    </div>
  );
}

export function ElevenLabsVoiceContent() {
  return (
    <ConversationProvider>
      <ElevenLabsVoiceInner />
    </ConversationProvider>
  );
}
