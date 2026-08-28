export type ConnectionStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "disconnected"
  | "error";

export interface Message {
  id: string;
  role: "user" | "assistant";
  text: string;
  isPartial?: boolean;
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
