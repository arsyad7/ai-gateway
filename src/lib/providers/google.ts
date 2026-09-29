import type {
  ChatResult,
  NormalizedRequest,
  ProviderAdapter,
  ProviderConfig,
  StreamEvent,
  TokenUsage,
} from "@/lib/types";
import { estimatePromptTokens, estimateTokens } from "@/lib/types";
import { iterateSse } from "@/lib/providers/sse";
import {
  networkError,
  readErrorBody,
  upstreamError,
} from "@/lib/providers/errors";

const BASE = "https://generativelanguage.googleapis.com/v1beta";

type GeminiUsage = {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  cachedContentTokenCount?: number;
};

function mapUsage(u: GeminiUsage | undefined): TokenUsage | null {
  if (!u) return null;
  return {
    promptTokens: u.promptTokenCount ?? 0,
    // Thinking tokens are billed as output.
    completionTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
    cachedReadTokens: u.cachedContentTokenCount ?? 0,
  };
}

function mapFinish(reason: string | undefined): string {
  switch (reason) {
    case "STOP":
      return "stop";
    case "MAX_TOKENS":
      return "length";
    case "SAFETY":
    case "PROHIBITED_CONTENT":
      return "content_filter";
    default:
      return reason?.toLowerCase() ?? "stop";
  }
}

function buildBody(req: NormalizedRequest): Record<string, unknown> {
  const contents = req.messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts:
        typeof m.content === "string"
          ? [{ text: m.content }]
          : m.content.map((p) =>
              p.type === "text"
                ? { text: p.text }
                : { inlineData: { mimeType: p.mediaType, data: p.data } },
            ),
    }));

  const generationConfig: Record<string, unknown> = {};
  if (req.maxTokens !== undefined) generationConfig.maxOutputTokens = req.maxTokens;
  if (req.temperature !== undefined) generationConfig.temperature = req.temperature;
  if (req.topP !== undefined) generationConfig.topP = req.topP;
  if (req.stop?.length) generationConfig.stopSequences = req.stop;

  const body: Record<string, unknown> = { contents, generationConfig };
  if (req.system) {
    body.systemInstruction = { parts: [{ text: req.system }] };
  }
  return body;
}

function textOf(json: any): string {
  const parts = json?.candidates?.[0]?.content?.parts ?? [];
  return parts
    .filter((p: any) => typeof p?.text === "string" && !p.thought)
    .map((p: any) => p.text)
    .join("");
}

async function call(
  cfg: ProviderConfig,
  model: string,
  method: "generateContent" | "streamGenerateContent",
  body: Record<string, unknown>,
): Promise<Response> {
  const base = (cfg.baseUrl || BASE).replace(/\/$/, "");
  const qs = method === "streamGenerateContent" ? "?alt=sse" : "";
  let res: Response;
  try {
    res = await fetch(`${base}/models/${model}:${method}${qs}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": cfg.apiKey,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw networkError("google", err);
  }
  if (!res.ok) {
    throw upstreamError("google", res.status, await readErrorBody(res));
  }
  return res;
}

export const googleAdapter: ProviderAdapter = {
  kind: "google",

  async chat(cfg, model, req): Promise<ChatResult> {
    const res = await call(
      cfg,
      model.upstreamModel,
      "generateContent",
      buildBody(req),
    );
    const json = await res.json();
    const text = textOf(json);
    return {
      text,
      finishReason: mapFinish(json?.candidates?.[0]?.finishReason),
      usage:
        mapUsage(json?.usageMetadata) ?? {
          promptTokens: estimatePromptTokens(req.messages),
          completionTokens: estimateTokens(text),
          estimated: true,
        },
    };
  },

  async *streamChat(cfg, model, req): AsyncGenerator<StreamEvent> {
    const res = await call(
      cfg,
      model.upstreamModel,
      "streamGenerateContent",
      buildBody(req),
    );
    if (!res.body) throw upstreamError("google", 502, "empty stream body");

    let finishReason = "stop";
    let usage: TokenUsage | null = null;
    let emitted = "";

    for await (const payload of iterateSse(res.body)) {
      let json: any;
      try {
        json = JSON.parse(payload);
      } catch {
        continue;
      }
      const text = textOf(json);
      if (text) {
        emitted += text;
        yield { type: "delta", text };
      }
      const fr = json?.candidates?.[0]?.finishReason;
      if (fr) finishReason = mapFinish(fr);
      usage = mapUsage(json?.usageMetadata) ?? usage;
    }

    yield {
      type: "done",
      finishReason,
      usage:
        usage ?? {
          promptTokens: estimatePromptTokens(req.messages),
          completionTokens: estimateTokens(emitted),
          estimated: true,
        },
    };
  },
};
