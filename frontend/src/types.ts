export type ConnectionStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "disconnected"
  | "error";

export type LatencyPhase = "idle" | "llm" | "tts" | "done";

export interface RoundLatency {
  asrMs: number | null;
  llmMs: number | null;
  ttsMs: number | null;
  totalMs: number | null;
  phase: LatencyPhase;
}

export interface Message {
  id: string;
  role: "user" | "assistant";
  text: string;
  isPartial?: boolean;
  latency?: RoundLatency;
}

export interface RealtimeState {
  status: ConnectionStatus;
  messages: Message[];
  error: string | null;
  isSpeaking: boolean;
}

export interface RealtimeActions {
  connect: (useLangfuse: boolean) => Promise<void>;
  disconnect: () => void;
}
