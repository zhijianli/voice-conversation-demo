export const API_BASE = `${import.meta.env.BASE_URL}api`.replace(/\/{2,}/g, "/");

export type VoiceLanguage = "en" | "zh";

export const MINIMAX_VOICES = [
  {
    id: "Chinese (Mandarin)_Wise_Women",
    label: "阅历姐姐",
  },
  {
    id: "Chinese (Mandarin)_Warm_Bestie",
    label: "温暖闺蜜",
  },
  {
    id: "Chinese (Mandarin)_Warm_Girl",
    label: "温暖少女",
  },
  {
    id: "Chinese (Mandarin)_IntellectualGirl",
    label: "知性少女",
  },
  {
    id: "Chinese (Mandarin)_Laid_BackGirl",
    label: "慵懒少女",
  },
] as const;

export type MinimaxVoiceId = (typeof MINIMAX_VOICES)[number]["id"];

export const DEFAULT_MINIMAX_VOICE_ID: MinimaxVoiceId =
  "Chinese (Mandarin)_IntellectualGirl";

export const MINIMAX_VOICE_STORAGE_KEY = "free-coach-minimax-voice-v2";

export function isMinimaxVoiceId(value: string): value is MinimaxVoiceId {
  return MINIMAX_VOICES.some((voice) => voice.id === value);
}

export function minimaxVoiceLabel(voiceId: string): string {
  return MINIMAX_VOICES.find((voice) => voice.id === voiceId)?.label ?? "中文音色";
}

export function transcribeSocketUrl(language: VoiceLanguage = "zh"): string {
  const query = `?language=${encodeURIComponent(language)}`;
  if (import.meta.env.DEV) {
    return `ws://127.0.0.1:8000/api/free-coach/transcribe${query}`;
  }
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}${API_BASE}/free-coach/transcribe${query}`;
}

export function resample(
  input: Float32Array,
  fromRate: number,
  toRate: number
): Float32Array {
  if (fromRate === toRate) {
    return input;
  }

  const ratio = fromRate / toRate;
  const output = new Float32Array(Math.max(1, Math.round(input.length / ratio)));
  for (let i = 0; i < output.length; i += 1) {
    const srcIndex = i * ratio;
    const left = Math.floor(srcIndex);
    const right = Math.min(left + 1, input.length - 1);
    const frac = srcIndex - left;
    output[i] = input[left] * (1 - frac) + input[right] * frac;
  }
  return output;
}

export function floatTo16BitPcm(input: Float32Array): ArrayBuffer {
  const pcm = new Int16Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, input[i]));
    pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return pcm.buffer;
}

export function pcmRms(buffer: ArrayBuffer): number {
  const samples = new Int16Array(buffer);
  if (!samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const normalized = samples[i] / 32768;
    sum += normalized * normalized;
  }
  return Math.sqrt(sum / samples.length);
}

const WORKLET_SOURCE = `
class PcmCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length) {
      const copy = new Float32Array(channel.length);
      copy.set(channel);
      this.port.postMessage(copy, [copy.buffer]);
    }
    return true;
  }
}
registerProcessor("pcm-capture", PcmCaptureProcessor);
`;

export async function createMicCapture(
  stream: MediaStream,
  onPcm: (pcm: ArrayBuffer) => void,
  targetSampleRate = 16000
): Promise<{ audioContext: AudioContext; stop: () => void }> {
  const audioContext = new AudioContext();
  await audioContext.resume();

  const workletUrl = URL.createObjectURL(
    new Blob([WORKLET_SOURCE], { type: "application/javascript" })
  );
  await audioContext.audioWorklet.addModule(workletUrl);
  URL.revokeObjectURL(workletUrl);

  const source = audioContext.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(audioContext, "pcm-capture");
  const mute = audioContext.createGain();
  mute.gain.value = 0;
  const frameSamples = Math.max(320, Math.round(targetSampleRate * 0.1));
  let leftover = new Float32Array(0);

  node.port.onmessage = (event: MessageEvent<Float32Array>) => {
    const resampled = resample(
      event.data,
      audioContext.sampleRate,
      targetSampleRate
    );
    const merged = new Float32Array(leftover.length + resampled.length);
    merged.set(leftover);
    merged.set(resampled, leftover.length);

    let offset = 0;
    while (merged.length - offset >= frameSamples) {
      onPcm(
        floatTo16BitPcm(merged.subarray(offset, offset + frameSamples))
      );
      offset += frameSamples;
    }
    leftover = merged.slice(offset);
  };

  source.connect(node);
  node.connect(mute);
  mute.connect(audioContext.destination);

  return {
    audioContext,
    stop: () => {
      node.port.onmessage = null;
      node.disconnect();
      source.disconnect();
      mute.disconnect();
      void audioContext.close();
    },
  };
}

const END_PUNCT = new Set(["。", "！", "？", "!", "?", "…"]);
const COMMA_PUNCT = new Set(["，", ",", "、"]);
const TRAILING_CLOSE = /["'”’」』)\]】]/;

function isDigit(ch: string | undefined): boolean {
  return !!ch && /\d/.test(ch);
}

function isTerminatingPunct(buffer: string, index: number): boolean {
  const ch = buffer[index];
  if (END_PUNCT.has(ch)) return true;
  if (COMMA_PUNCT.has(ch)) {
    return !(isDigit(buffer[index - 1]) && isDigit(buffer[index + 1]));
  }
  if (ch !== ".") return false;
  const prev = buffer[index - 1];
  const next = buffer[index + 1];
  if (isDigit(prev) && isDigit(next)) return false;
  if (next && /[A-Za-z]/.test(next)) return false;
  return !next || /\s/.test(next) || TRAILING_CLOSE.test(next);
}

/** Emit a clip when a sentence or comma clause is complete. */
export function drainSentences(buffer: string): {
  sentences: string[];
  rest: string;
} {
  const sentences: string[] = [];
  let start = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    if (!isTerminatingPunct(buffer, i)) continue;
    let end = i + 1;
    while (end < buffer.length && TRAILING_CLOSE.test(buffer[end])) {
      end += 1;
    }
    const sentence = buffer.slice(start, end).trim();
    if (sentence) sentences.push(sentence);
    start = end;
    i = end - 1;
  }
  return { sentences, rest: buffer.slice(start) };
}

export const FLUSH_COMPLETE_MS = 700;
export const FLUSH_DEFAULT_MS = 850;
export const FLUSH_INCOMPLETE_MS = 1600;
export const FLUSH_MIC_HOLD_MS = 400;
export const FLUSH_MAX_MS = 2400;

const COMPLETE_END = /[。！？!?]$/;
const INCOMPLETE_END_PUNCT = /[,，、…]$/;
const COMPLETE_SHORT_ZH =
  /^(嗯+|啊+|好的?|对|是的?|不是|谢谢|行|可以|没了|没有|结束|拜拜|再见|ok|okay)$/i;
const COMPLETE_SHORT_EN =
  /^(yes|yeah|yep|no|nope|ok|okay|thanks|thank you|sure|right|done|bye|hello|hi)$/i;
const INCOMPLETE_TRAIL_ZH =
  /(?:然后|而且|但是|不过|因为|所以|如果|虽然|或者|还是|还有|就是说|就是|其实|比如说|比如|那个|这个|的话|以及|我觉得|我想|可能是|可能|应该是|嗯+|啊+|呃+)$/;
const INCOMPLETE_TRAIL_EN =
  /(?:\b(?:and|but|or|so|because|if|when|although|and then|or maybe|i think|i mean|you know|like|well|actually|um+|uh+|er+)\s*)$/i;
const HOLD_OPEN_ZH =
  /(?:让我想想|我想想看|我想想|等一下|稍等一下|稍等|你等我一下)[啊呀呢吧]*[。！？!?…]*$/;
const HOLD_OPEN_EN =
  /(?:\b(?:let me think|i(?:'m| am) thinking|hold on|wait a second|wait)\b)[.!?…]*$/i;

function stripTrailingClose(text: string): string {
  return text.trim().replace(/["'”’」』)\]】]+$/u, "");
}

export function isCoachTurnBusy(message: string): boolean {
  return /already processing/i.test(message);
}

/** Silence to wait after an STT final, based on whether the utterance looks finished. */
export function endpointFlushMs(
  text: string,
  language: VoiceLanguage
): number {
  const stripped = stripTrailingClose(text);
  if (!stripped) return FLUSH_DEFAULT_MS;
  if (HOLD_OPEN_ZH.test(stripped) || HOLD_OPEN_EN.test(stripped)) {
    return FLUSH_INCOMPLETE_MS;
  }
  if (COMPLETE_END.test(stripped)) return FLUSH_COMPLETE_MS;
  if (INCOMPLETE_END_PUNCT.test(stripped)) return FLUSH_INCOMPLETE_MS;
  if (INCOMPLETE_TRAIL_ZH.test(stripped) || INCOMPLETE_TRAIL_EN.test(stripped)) {
    return FLUSH_INCOMPLETE_MS;
  }
  if (language === "zh") {
    const chars = stripped.replace(/\s+/g, "");
    if (chars.length <= 2 && !COMPLETE_SHORT_ZH.test(chars)) {
      return FLUSH_INCOMPLETE_MS;
    }
  } else {
    const words = stripped.split(/\s+/).filter(Boolean);
    if (words.length <= 2 && !COMPLETE_SHORT_EN.test(stripped)) {
      return FLUSH_INCOMPLETE_MS;
    }
  }
  return FLUSH_DEFAULT_MS;
}

export async function readSseStream(
  response: Response,
  onEvent: (event: string, data: Record<string, unknown>) => void
): Promise<void> {
  if (!response.body) {
    throw new Error("服务器未返回流式响应");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const consume = (block: string) => {
    let eventName = "";
    const dataLines: string[] = [];
    for (const line of block.replace(/\r\n/g, "\n").split("\n")) {
      if (line.startsWith("event:")) eventName = line.slice(6).trim();
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    if (!eventName) return;
    const raw = dataLines.join("\n");
    let data: Record<string, unknown> = {};
    try {
      data = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } catch {
      data = { raw };
    }
    onEvent(eventName, data);
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        consume(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) consume(buffer);
  } finally {
    reader.releaseLock();
  }
}
