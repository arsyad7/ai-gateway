import type { ImagePart, TokenUsage } from "@/lib/types";

/** One tool invocation requested by the model. */
export type ToolCall = {
  id: string;
  name: string;
  /** Parsed arguments object. */
  args: Record<string, unknown>;
};

/**
 * Provider-neutral agent transcript message. `raw` optionally keeps the
 * provider's original assistant content (e.g. Anthropic content blocks with
 * thinking) so the same provider can replay it verbatim on the next turn.
 */
export type AgentMsg =
  | { role: "user"; content: string; images?: ImagePart[] }
  | { role: "assistant"; content: string; toolCalls: ToolCall[]; raw?: unknown; rawKind?: string }
  | { role: "tool"; toolCallId: string; name: string; content: string };

/** Earlier conversation turn supplied by the caller for a follow-up task. */
export type AgentHistoryMsg = { role: "user" | "assistant"; content: string };

/** JSON-schema-described tool exposed to the model. */
export type ToolSpec = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

/** Result of one LLM call inside the loop. */
export type AgentStep = {
  text: string;
  toolCalls: ToolCall[];
  usage: TokenUsage;
  finish: string;
  /** Provider-native assistant content for faithful replay. */
  raw?: unknown;
};

/** Progress events streamed to the caller while the loop runs. */
export type AgentEvent =
  | { type: "start"; model: string; maxIterations: number }
  | { type: "iteration"; n: number; model: string }
  | { type: "assistant"; text: string }
  | { type: "tool_call"; id: string; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; id: string; name: string; result: string; isError: boolean }
  | { type: "model_switch"; from: string; to: string; reason: string }
  | {
      type: "done";
      answer: string;
      iterations: number;
      model: string;
      usage: { promptTokens: number; completionTokens: number; costUsd: number };
    }
  | { type: "error"; message: string; code: string };
