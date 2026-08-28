export const API_BASE = `${import.meta.env.BASE_URL}api`.replace(/\/{2,}/g, "/");

export function transcribeSocketUrl(): string {
  if (import.meta.env.DEV) {
    return "ws://127.0.0.1:8000/api/free-coach/transcribe";
  }
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}${API_BASE}/free-coach/transcribe`;
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
const TRAILING_CLOSE = /["'”’」』)\]】]/;

function isTerminatingPunct(buffer: string, index: number): boolean {
  const ch = buffer[index];
  if (END_PUNCT.has(ch)) return true;
  if (ch !== ".") return false;
  const prev = buffer[index - 1];
  const next = buffer[index + 1];
  if (prev && /\d/.test(prev) && next && /\d/.test(next)) return false;
  if (next && /[A-Za-z]/.test(next)) return false;
  return !next || /\s/.test(next) || TRAILING_CLOSE.test(next);
}

/** Only emit sentences that end with terminating punctuation. */
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
