import type {
  ChatResult,
  NormalizedRequest,
  ProviderAdapter,
  ProviderConfig,
  StreamEvent,
  TokenUsage,
} from "@/lib/types";
import { estimatePromptTokens, type ChatMessage } from "@/lib/types";

/** Parts go out in OpenAI's own shape; images as data URLs. */
function toOpenAiContent(content: ChatMessage["content"]) {
  if (typeof content === "string") return content;
  return content.map((p) =>
    p.type === "text"
      ? { type: "text", text: p.text }
      : { type: "image_url", image_url: { url: `data:${p.mediaType};base64,${p.data}` } },
  );
}
import { iterateSse } from "@/lib/providers/sse";
import {
  networkError,
  readErrorBody,
  upstreamError,
} from "@/lib/providers/errors";

const OPENAI_BASE = "https://api.openai.com/v1";

type OpenAIUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
};

function mapUsage(u: OpenAIUsage | undefined | null): TokenUsage | null {
  if (!u) return null;
  return {
    promptTokens: u.prompt_tokens ?? 0,
    completionTokens: u.completion_tokens ?? 0,
    cachedReadTokens: u.prompt_tokens_details?.cached_tokens ?? 0,
  };
}

function buildBody(
  upstreamModel: string,
  req: NormalizedRequest,
  reasoning: boolean,
  stream: boolean,
): Record<string, unknown> {
  const messages = [
    ...(req.system ? [{ role: "system", content: req.system }] : []),
    ...req.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role, content: toOpenAiContent(m.content) })),
  ];
  const body: Record<string, unknown> = { model: upstreamModel, messages };
  if (req.maxTokens !== undefined) body.max_completion_tokens = req.maxTokens;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.topP !== undefined) body.top_p = req.topP;
  if (req.stop?.length) body.stop = req.stop;
  if (reasoning && req.reasoningEffort) {
    // OpenAI accepts low|medium|high; clamp the Anthropic-only tiers.
    const effort = ["low", "medium", "high"].includes(req.reasoningEffort)
      ? req.reasoningEffort
      : "high";
    body.reasoning_effort = effort;
  }
  if (stream) {
    body.stream = true;
    body.stream_options = { include_usage: true };
  }
  return body;
}

function makeAdapter(kind: string, defaultBase: string | null): ProviderAdapter {
  async function call(
    cfg: ProviderConfig,
    body: Record<string, unknown>,
  ): Promise<Response> {
    const base = (cfg.baseUrl || defaultBase || OPENAI_BASE).replace(/\/$/, "");
    let res: Response;
    try {
      res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw networkError(kind, err);
    }
    if (!res.ok) {
      throw upstreamError(kind, res.status, await readErrorBody(res));
    }
    return res;
  }

  return {
    kind,

    async chat(cfg, model, req): Promise<ChatResult> {
      const res = await call(
        cfg,
        buildBody(model.upstreamModel, req, model.reasoning, false),
      );
      const json = await res.json();
      const choice = json.choices?.[0];
      const text: string = choice?.message?.content ?? "";
      const usage =
        mapUsage(json.usage) ?? {
          promptTokens: estimatePromptTokens(req.messages),
          completionTokens: Math.max(1, Math.ceil(text.length / 4)),
          estimated: true,
        };
      return { text, finishReason: choice?.finish_reason ?? "stop", usage };
    },

    async *streamChat(cfg, model, req): AsyncGenerator<StreamEvent> {
      const res = await call(
        cfg,
        buildBody(model.upstreamModel, req, model.reasoning, true),
      );
      if (!res.body) throw upstreamError(kind, 502, "empty stream body");

      let finishReason = "stop";
      let usage: TokenUsage | null = null;
      let emitted = "";

      for await (const payload of iterateSse(res.body)) {
        let json: any;
        try {
          json = JSON.parse(payload);
        } catch {
          continue; // tolerate keep-alive noise from some compatible servers
        }
        const choice = json.choices?.[0];
        const delta: string | undefined = choice?.delta?.content;
        if (delta) {
          emitted += delta;
          yield { type: "delta", text: delta };
        }
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        // Usage arrives on the final chunk when stream_options.include_usage set.
        usage = mapUsage(json.usage) ?? usage;
      }

      yield {
        type: "done",
        finishReason,
        usage:
          usage ?? {
            promptTokens: estimatePromptTokens(req.messages),
            completionTokens: Math.max(1, Math.ceil(emitted.length / 4)),
            estimated: true,
          },
      };
    },
  };
}

export const openaiAdapter = makeAdapter("openai", OPENAI_BASE);
/** Any OpenAI-compatible server: OpenRouter, Groq, DeepSeek, Ollama, vLLM... */
export const openaiCompatibleAdapter = makeAdapter("openai_compatible", null);
