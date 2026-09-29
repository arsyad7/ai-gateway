import Anthropic from "@anthropic-ai/sdk";
import type {
  ChatResult,
  NormalizedRequest,
  ProviderAdapter,
  ProviderConfig,
  StreamEvent,
  TokenUsage,
  UpstreamModel,
} from "@/lib/types";
import { networkError, upstreamError } from "@/lib/providers/errors";

function client(cfg: ProviderConfig): Anthropic {
  return new Anthropic({
    apiKey: cfg.apiKey,
    ...(cfg.baseUrl ? { baseURL: cfg.baseUrl } : {}),
  });
}

function buildParams(
  model: UpstreamModel,
  req: NormalizedRequest,
): Anthropic.MessageCreateParams {
  const params: Anthropic.MessageCreateParams = {
    model: model.upstreamModel,
    max_tokens: req.maxTokens ?? model.maxOutputTokens ?? 16000,
    messages: req.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content:
          typeof m.content === "string"
            ? m.content
            : m.content.map((p): Anthropic.ContentBlockParam =>
                p.type === "text"
                  ? { type: "text", text: p.text }
                  : {
                      type: "image",
                      source: {
                        type: "base64",
                        media_type: p.mediaType as "image/png",
                        data: p.data,
                      },
                    },
              ),
      })),
  };
  if (req.system) params.system = req.system;
  if (req.temperature !== undefined) params.temperature = req.temperature;
  if (req.topP !== undefined) params.top_p = req.topP;
  if (req.stop?.length) params.stop_sequences = req.stop;
  if (model.reasoning) {
    params.thinking = { type: "adaptive" };
    if (req.reasoningEffort) {
      params.output_config = {
        effort: req.reasoningEffort as "low" | "medium" | "high" | "xhigh" | "max",
      };
    }
  }
  return params;
}

function mapUsage(u: Anthropic.Usage): TokenUsage {
  const cached = u.cache_read_input_tokens ?? 0;
  const cacheWrite = u.cache_creation_input_tokens ?? 0;
  return {
    promptTokens: (u.input_tokens ?? 0) + cached + cacheWrite,
    completionTokens: u.output_tokens ?? 0,
    cachedReadTokens: cached,
    cacheWriteTokens: cacheWrite,
  };
}

function mapStop(reason: string | null): string {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "refusal":
      return "content_filter";
    default:
      return reason ?? "stop";
  }
}

function translateError(err: unknown): never {
  if (err instanceof Anthropic.APIError) {
    throw upstreamError("anthropic", err.status ?? 502, err.message);
  }
  throw networkError("anthropic", err);
}

export const anthropicAdapter: ProviderAdapter = {
  kind: "anthropic",

  async chat(cfg, model, req): Promise<ChatResult> {
    try {
      const res = await client(cfg).messages.create({
        ...buildParams(model, req),
        stream: false,
      });
      const text = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
      return {
        text,
        finishReason: mapStop(res.stop_reason),
        usage: mapUsage(res.usage),
      };
    } catch (err) {
      translateError(err);
    }
  },

  async *streamChat(cfg, model, req): AsyncGenerator<StreamEvent> {
    let stream: ReturnType<Anthropic["messages"]["stream"]>;
    try {
      stream = client(cfg).messages.stream(buildParams(model, req));
    } catch (err) {
      translateError(err);
    }
    try {
      for await (const event of stream) {
        if (
          event.type === "content_block_delta" &&
          event.delta.type === "text_delta"
        ) {
          yield { type: "delta", text: event.delta.text };
        }
      }
      const final = await stream.finalMessage();
      yield {
        type: "done",
        finishReason: mapStop(final.stop_reason),
        usage: mapUsage(final.usage),
      };
    } catch (err) {
      translateError(err);
    }
  },
};
