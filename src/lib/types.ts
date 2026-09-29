/** Provider-neutral request shape. Every adapter translates from this. */
export type ChatRole = "system" | "user" | "assistant";

export type TextPart = { type: "text"; text: string };
/** Inline image; always base64 so every adapter can forward it. */
export type ImagePart = { type: "image"; mediaType: string; data: string };
export type ContentPart = TextPart | ImagePart;

/** Content is a plain string unless the message carries images. */
export type ChatMessage = { role: ChatRole; content: string | ContentPart[] };

export function messageText(m: { content: string | ContentPart[] }): string {
  if (typeof m.content === "string") return m.content;
  return m.content
    .filter((p): p is TextPart => p.type === "text")
    .map((p) => p.text)
    .join("");
}

export function messageImages(m: { content: string | ContentPart[] }): ImagePart[] {
  if (typeof m.content === "string") return [];
  return m.content.filter((p): p is ImagePart => p.type === "image");
}

export function hasImages(messages: ChatMessage[]): boolean {
  return messages.some((m) => messageImages(m).length > 0);
}

export type NormalizedRequest = {
  messages: ChatMessage[];
  /** Collapsed from any leading system messages. */
  system?: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stop?: string[];
  stream: boolean;
  /** low | medium | high | xhigh | max — ignored by providers that lack it. */
  reasoningEffort?: string;
};

export type TokenUsage = {
  promptTokens: number;
  completionTokens: number;
  /** Prompt tokens served from a provider cache (billed at a discount). */
  cachedReadTokens?: number;
  /** Prompt tokens written into a provider cache (billed at a premium). */
  cacheWriteTokens?: number;
  /** True when the provider returned no usage and we approximated it. */
  estimated?: boolean;
};

export type ChatResult = {
  text: string;
  finishReason: string;
  usage: TokenUsage;
};

export type StreamEvent =
  | { type: "delta"; text: string }
  /** Hidden reasoning in progress: no text yet, but the model is working. */
  | { type: "progress"; thinkingTokens: number }
  | { type: "done"; finishReason: string; usage: TokenUsage };

export type ProviderConfig = {
  apiKey: string;
  baseUrl?: string | null;
};

export type UpstreamModel = {
  upstreamModel: string;
  maxOutputTokens?: number | null;
  reasoning: boolean;
};

export interface ProviderAdapter {
  kind: string;
  chat(
    cfg: ProviderConfig,
    model: UpstreamModel,
    req: NormalizedRequest,
  ): Promise<ChatResult>;
  streamChat(
    cfg: ProviderConfig,
    model: UpstreamModel,
    req: NormalizedRequest,
  ): AsyncGenerator<StreamEvent>;
}

/** Thrown by adapters and the router; carries the HTTP status to return. */
export class GatewayError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    /** Whether trying the next candidate model could plausibly succeed. */
    readonly retryable = false,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

/** Rough token estimate, used only when a provider omits usage on a stream. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/** Whole-prompt estimate; each image counts a flat 1,000 tokens. */
export function estimatePromptTokens(messages: ChatMessage[]): number {
  let n = 0;
  for (const m of messages) {
    n += estimateTokens(messageText(m)) + messageImages(m).length * 1000;
  }
  return n;
}
