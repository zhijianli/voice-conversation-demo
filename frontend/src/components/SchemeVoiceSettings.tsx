import type { MinimaxVoiceId, VoiceLanguage } from "../lib/voice";
import { MINIMAX_VOICES } from "../lib/voice";

interface SchemeVoiceSettingsProps {
  language: VoiceLanguage;
  onLanguageChange: (language: VoiceLanguage) => void;
  voiceId?: MinimaxVoiceId;
  onVoiceChange?: (voiceId: MinimaxVoiceId) => void;
  languageDisabled?: boolean;
}

export function SchemeVoiceSettings({
  language,
  onLanguageChange,
  voiceId,
  onVoiceChange,
  languageDisabled = false,
}: SchemeVoiceSettingsProps) {
  return (
    <div className="scheme-overview__settings">
      <div
        className={`language-switch ${languageDisabled ? "disabled" : ""}`}
        role="group"
        aria-label="识别与朗读语言"
      >
        <button
          type="button"
          className={language === "zh" ? "active" : ""}
          disabled={languageDisabled}
          onClick={() => onLanguageChange("zh")}
        >
          中文
        </button>
        <button
          type="button"
          className={language === "en" ? "active" : ""}
          disabled={languageDisabled}
          onClick={() => onLanguageChange("en")}
        >
          English
        </button>
      </div>

      {onVoiceChange && voiceId != null && language === "zh" ? (
        <div className="voice-picker" role="group" aria-label="教练音色">
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
    </div>
  );
}
