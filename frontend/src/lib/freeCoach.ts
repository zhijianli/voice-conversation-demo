import type { VoiceLanguage } from "./voice";

export const OPENING_ZH = "我在这里。你现在最想看清楚的是什么？";
export const OPENING_EN =
  "I am here. What feels most worth looking at right now?";

export const OPENING_TEXT: Record<VoiceLanguage, string> = {
  zh: OPENING_ZH,
  en: OPENING_EN,
};

export const OPENING_AUDIO: Record<VoiceLanguage, string> = {
  zh: `${import.meta.env.BASE_URL}audio/opening-zh.mp3`,
  en: `${import.meta.env.BASE_URL}audio/opening-en.mp3`,
};
