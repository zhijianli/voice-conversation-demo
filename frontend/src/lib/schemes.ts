export type CategoryId = "s2s" | "pipeline" | "platform";

export type SchemeId =
  | "openai"
  | "gemini-live"
  | "doubao"
  | "bailian"
  | "free-coach"
  | "livekit"
  | "elevenlabs"
  | "deepgram";

export interface SchemeMetrics {
  unitCost: string;
  /** 30 分钟成本如何由单价推算 */
  costFormula: string;
  costEstimate: string;
}

export interface SchemeModels {
  /** 对话 / 推理模型（S2S 方案即端到端语音模型） */
  llm: string;
  /** 语音识别（ASR / STT） */
  asr: string;
  /** 语音合成（TTS） */
  tts: string;
}

export interface SchemeMeta {
  id: SchemeId;
  category: CategoryId;
  name: string;
  implemented: boolean;
  tagline: string;
  flow: string;
  models: SchemeModels;
  metrics: SchemeMetrics;
}

export interface CategoryMeta {
  id: CategoryId;
  label: string;
  description: string;
}

export const CATEGORIES: CategoryMeta[] = [
  {
    id: "s2s",
    label: "端到端",
    description: "听 + 想 + 说在一个模型 / API 内完成（Speech-to-Speech）",
  },
  {
    id: "platform",
    label: "编排平台",
    description: "语音平台负责听 / 说 / 轮次，对话逻辑走 volo",
  },
  {
    id: "pipeline",
    label: "自主拼接",
    description: "STT、自有 LLM、TTS 分项选型，编排逻辑自研",
  },
];

export const SCHEMES: SchemeMeta[] = [
  {
    id: "openai",
    category: "s2s",
    name: "OpenAI Realtime",
    implemented: true,
    tagline: "OpenAI 语音模型方案",
    flow: "麦克风 → OpenAI Realtime → 扬声器",
    models: {
      llm: "gpt-realtime-2.1（女声 marin）",
      asr: "",
      tts: "",
    },
    metrics: {
      unitCost: "约 $0.025–0.05 / 分钟",
      costFormula: "费用单价 × 30 分钟（按 Realtime 连接时长）",
      costEstimate: "$0.7–1.5 / 30 分钟",
    },
  },
  {
    id: "gemini-live",
    category: "s2s",
    name: "Gemini Live",
    implemented: true,
    tagline: "Google 语音模型方案",
    flow: "麦克风 → Gemini Live API → 扬声器",
    models: {
      llm: "gemini-2.5-flash-native-audio（女声 Kore）",
      asr: "",
      tts: "",
    },
    metrics: {
      unitCost: "约 $0.01–0.027 / 分钟",
      costFormula: "费用单价 × 30 分钟（按 Live API 连接时长）",
      costEstimate: "$0.3–0.8 / 30 分钟",
    },
  },
  {
    id: "doubao",
    category: "s2s",
    name: "豆包实时语音",
    implemented: true,
    tagline: "字节跳动（火山引擎）语音模型方案",
    flow: "麦克风 → 豆包 Realtime Dialogue → 扬声器",
    models: {
      llm: "Doubao Realtime（女声 VV）",
      asr: "",
      tts: "",
    },
    metrics: {
      unitCost: "待确认（约 $0.017–0.05 / 分钟）",
      costFormula: "费用单价 × 30 分钟（按实时对话连接时长）",
      costEstimate: "待确认（约 $0.5–1.5 / 30 分钟）",
    },
  },
  {
    id: "bailian",
    category: "s2s",
    name: "百炼 Qwen-Audio",
    implemented: true,
    tagline: "阿里巴巴（百炼）语音模型方案",
    flow: "麦克风 → Qwen-Audio Realtime → 扬声器",
    models: {
      llm: "qwen-audio-3.0-realtime-flash（女声 longanqian）",
      asr: "",
      tts: "",
    },
    metrics: {
      unitCost: "约 ¥0.2–0.5 / 分钟（Flash 估算）",
      costFormula: "费用单价 × 30 分钟（按 WebSocket 连接时长）",
      costEstimate: "约 ¥6–15 / 30 分钟（Flash 估算）",
    },
  },
  {
    id: "free-coach",
    category: "pipeline",
    name: "拼接方案1",
    implemented: true,
    tagline: "volo 自研拼接方案",
    flow: "麦克风 → Transcribe → volo → MiniMax/Polly → 扬声器",
    models: {
      llm: "volo free-coach",
      asr: "Amazon Transcribe Streaming",
      tts: "MiniMax speech-2.6-turbo / Polly Generative（Ruth）",
    },
    metrics: {
      unitCost: "约 $0.007–0.017 / 分钟",
      costFormula: "综合单价 × 30 分钟（Transcribe + volo + TTS）",
      costEstimate: "$0.2–0.5 / 30 分钟",
    },
  },
  {
    id: "livekit",
    category: "pipeline",
    name: "拼接方案2",
    implemented: true,
    tagline: "LiveKit 语音框架方案",
    flow: "麦克风 → Deepgram Nova-3 → volo → MiniMax 女声 → 扬声器",
    models: {
      llm: "volo free-coach",
      asr: "Deepgram Nova-3",
      tts: "MiniMax speech-2.6-turbo（知性少女等女声）",
    },
    metrics: {
      unitCost: "约 $0.007–0.02 / 分钟（不含基础设施）",
      costFormula: "综合单价 × 30 分钟（Deepgram STT + volo + MiniMax TTS）+ 基础设施",
      costEstimate: "$0.2–0.6 / 30 分钟 + 基础设施",
    },
  },
  {
    id: "elevenlabs",
    category: "platform",
    name: "ElevenLabs",
    implemented: true,
    tagline: "ElevenLabs 语音平台方案",
    flow: "麦克风 → ElevenLabs Agent ⇄ volo (Custom LLM) → 扬声器",
    models: {
      llm: "volo free-coach",
      asr: "",
      tts: "",
    },
    metrics: {
      unitCost: "$0.08 / 分钟（连接时长）",
      costFormula: "0.08 × 30 ≈ $2.4（平台连接费；volo LLM 推理另计）",
      costEstimate: "$2.4–2.8 / 30 分钟",
    },
  },
  {
    id: "deepgram",
    category: "platform",
    name: "Deepgram VA",
    implemented: true,
    tagline: "Deepgram 语音平台方案",
    flow: "麦克风 → Deepgram Voice Agent ⇄ volo → 扬声器",
    models: {
      llm: "volo free-coach",
      asr: "Deepgram Nova-3（平台内置）",
      tts: "OpenAI TTS nova（女声）/ Aura thalia",
    },
    metrics: {
      unitCost: "约 $0.067–0.083 / 分钟",
      costFormula: "费用单价 × 30 分钟（Voice Agent 连接时长；volo LLM 另计）",
      costEstimate: "$2.0–2.5 / 30 分钟",
    },
  },
];

export const DEFAULT_SCHEME: SchemeId = "free-coach";

export function schemesForCategory(category: CategoryId): SchemeMeta[] {
  return SCHEMES.filter((scheme) => scheme.category === category);
}

export function getScheme(id: SchemeId): SchemeMeta | undefined {
  return SCHEMES.find((scheme) => scheme.id === id);
}

export function getCategory(id: CategoryId): CategoryMeta | undefined {
  return CATEGORIES.find((category) => category.id === id);
}

export interface ParsedRoute {
  category: CategoryId;
  scheme: SchemeId;
}

function normalizePath(pathname: string): string {
  const base = import.meta.env.BASE_URL.replace(/\/+$/, "");
  let path = pathname.replace(/\/+$/, "") || "/";
  if (base && base !== "/" && path.startsWith(base)) {
    path = path.slice(base.length) || "/";
  }
  return path.replace(/\/+$/, "") || "/";
}

export function parseRoute(pathname = window.location.pathname): ParsedRoute {
  const path = normalizePath(pathname);

  if (path === "/openai") {
    return { category: "s2s", scheme: "openai" };
  }
  if (path === "/elevenlabs") {
    return { category: "platform", scheme: "elevenlabs" };
  }
  if (path === "/free-coach" || path === "/") {
    return { category: "pipeline", scheme: "free-coach" };
  }

  const match = path.match(/^\/(s2s|pipeline|platform)\/([a-z0-9-]+)$/);
  if (match) {
    const category = match[1] as CategoryId;
    const schemeId = match[2] as SchemeId;
    const scheme = getScheme(schemeId);
    if (scheme && scheme.category === category) {
      return { category, scheme: schemeId };
    }
  }

  return { category: "pipeline", scheme: DEFAULT_SCHEME };
}

export function schemeHref(category: CategoryId, scheme: SchemeId): string {
  const base = import.meta.env.BASE_URL.replace(/\/{2,}/g, "/");
  return `${base}${category}/${scheme}`.replace(/\/{2,}/g, "/");
}

export function categoryHref(category: CategoryId): string {
  const first = schemesForCategory(category)[0];
  return schemeHref(category, first?.id ?? DEFAULT_SCHEME);
}

export function stars(count: number): string {
  return "★".repeat(count) + "☆".repeat(Math.max(0, 5 - count));
}
