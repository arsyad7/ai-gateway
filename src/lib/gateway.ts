import type { ApiKey } from "@prisma/client";
import { prisma } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import { getAdapter } from "@/lib/providers";
import { sseFrame, SSE_DONE } from "@/lib/providers/sse";
import { route, type Candidate } from "@/lib/router";
import { computeCost } from "@/lib/usage";
import {
  GatewayError,
  hasImages,
  messageText,
  type ChatMessage,
  type ContentPart,
  type ImagePart,
  type NormalizedRequest,
  type TokenUsage,
} from "@/lib/types";

/** Body accepted at POST /v1/chat/completions (OpenAI-compatible subset). */
type IncomingBody = {
  model?: string;
  messages?: { role?: string; content?: unknown }[];
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  stream?: boolean;
  reasoning_effort?: string;
};

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Accepts only inline base64 images so every provider can be served alike. */
export function parseImage(url: string): ImagePart {
  const m = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(url);
  const mediaType = m?.[1].toLowerCase() ?? "";
  if (!m || !IMAGE_TYPES.has(mediaType)) {
    throw new GatewayError(
      "Images must be base64 data: URLs of type image/png, image/jpeg, image/gif or image/webp",
      400,
      "invalid_request",
    );
  }
  const data = m[2].replace(/\s/g, "");
  if (data.length * 0.75 > MAX_IMAGE_BYTES) {
    throw new GatewayError("Each image must be 5 MB or smaller", 400, "invalid_request");
  }
  return { type: "image", mediaType, data };
}

/**
 * Accepts a string, the OpenAI array-of-parts form (text / image_url) and the
 * Anthropic base64 image block. Text-only arrays collapse back to a string so
 * every adapter keeps using its plain path.
 */
function normalizeContent(content: unknown): string | ContentPart[] {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: ContentPart[] = [];
  for (const p of content) {
    if (typeof p === "string") {
      parts.push({ type: "text", text: p });
    } else if (!p || typeof p !== "object") {
      continue;
    } else if (p.type === "text" && typeof p.text === "string") {
      parts.push({ type: "text", text: p.text });
    } else if (p.type === "image_url") {
      const url = typeof p.image_url === "string" ? p.image_url : p.image_url?.url;
      if (typeof url === "string") parts.push(parseImage(url));
    } else if (p.type === "image" && p.source?.type === "base64") {
      parts.push(parseImage(`data:${p.source.media_type};base64,${p.source.data}`));
    }
  }
  return parts.some((p) => p.type === "image")
    ? parts
    : parts.map((p) => (p as { text: string }).text).join("");
}

export function normalize(body: IncomingBody): NormalizedRequest {
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new GatewayError(
      "'messages' must be a non-empty array",
      400,
      "invalid_request",
    );
  }
  const messages: ChatMessage[] = body.messages.map((m) => ({
    role: m.role === "assistant" || m.role === "system" ? m.role : "user",
    content: normalizeContent(m.content),
  }));
  const system =
    messages
      .filter((m) => m.role === "system")
      .map(messageText)
      .join("\n\n") || undefined;

  return {
    messages,
    system,
    maxTokens: body.max_completion_tokens ?? body.max_tokens,
    temperature: body.temperature,
    topP: body.top_p,
    stop:
      typeof body.stop === "string" ? [body.stop] : (body.stop ?? undefined),
    stream: body.stream === true,
    reasoningEffort: body.reasoning_effort,
  };
}

type LogParams = {
  apiKey: ApiKey;
  candidate: Candidate | null;
  requestedModel: string;
  routedReason: string;
  usage: TokenUsage | null;
  latencyMs: number;
  status: "ok" | "error" | "rejected";
  stream: boolean;
  errorCode?: string;
  errorMsg?: string;
};

async function writeLog(p: LogParams): Promise<void> {
  const usage = p.usage;
  const model = p.candidate?.model;
  await prisma.usageLog
    .create({
      data: {
        apiKeyId: p.apiKey.id,
        modelId: model?.id ?? null,
        modelAlias: model?.alias ?? "-",
        providerKind: model?.provider.kind ?? "-",
        providerName: model?.provider.name ?? "-",
        requestedModel: p.requestedModel,
        routedReason: p.routedReason,
        promptTokens: usage?.promptTokens ?? 0,
        completionTokens: usage?.completionTokens ?? 0,
        totalTokens: (usage?.promptTokens ?? 0) + (usage?.completionTokens ?? 0),
        costUsd: model && usage ? computeCost(model, usage) : 0,
        latencyMs: p.latencyMs,
        status: p.status,
        errorCode: p.errorCode ?? null,
        errorMsg: p.errorMsg?.slice(0, 500) ?? null,
        stream: p.stream,
      },
    })
    .catch((e) => console.error("usage log write failed:", e));
}

function completionId(): string {
  return `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

export function errorResponse(err: unknown): Response {
  const g =
    err instanceof GatewayError
      ? err
      : new GatewayError(
          err instanceof Error ? err.message : "Internal error",
          500,
          "internal_error",
        );
  if (!(err instanceof GatewayError)) console.error(err);
  return Response.json(
    { error: { message: g.message, type: g.code, code: g.code } },
    { status: g.status },
  );
}

/**
 * Runs a normalized request through the candidate list: first model that
 * succeeds wins; retryable upstream failures fall through to the next.
 */
export async function handleChat(
  apiKey: ApiKey,
  rawBody: IncomingBody,
): Promise<Response> {
  let requestedModel = (rawBody.model ?? "auto").trim();
  const req = normalize(rawBody);
  // Plain "auto" with images prefers models tagged "vision", when any exist;
  // an explicit alias or tag is always respected as given.
  if (requestedModel === "auto" && hasImages(req.messages)) {
    const visionModels = await prisma.model.count({
      where: { enabled: true, tags: { contains: "vision" } },
    });
    if (visionModels > 0) requestedModel = "auto:vision";
  }
  const { candidates, reason } = await route(requestedModel, apiKey);
  const started = Date.now();

  let lastError: GatewayError | null = null;

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const { model } = candidate;
    const adapter = getAdapter(model.provider.kind);
    const cfg = {
      apiKey: decryptSecret(model.provider.apiKeyEnc),
      baseUrl: model.provider.baseUrl,
    };
    const upstream = {
      upstreamModel: model.upstreamModel,
      maxOutputTokens: model.maxOutputTokens,
      reasoning: model.reasoning,
    };
    const routedReason = i === 0 ? reason : "fallback";

    try {
      if (!req.stream) {
        const result = await adapter.chat(cfg, upstream, req);
        await writeLog({
          apiKey,
          candidate,
          requestedModel,
          routedReason,
          usage: result.usage,
          latencyMs: Date.now() - started,
          status: "ok",
          stream: false,
        });
        return Response.json({
          id: completionId(),
          object: "chat.completion",
          created: Math.floor(started / 1000),
          model: model.alias,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: result.text },
              finish_reason: result.finishReason,
            },
          ],
          usage: {
            prompt_tokens: result.usage.promptTokens,
            completion_tokens: result.usage.completionTokens,
            total_tokens:
              result.usage.promptTokens + result.usage.completionTokens,
          },
        });
      }

      // Streaming: probe the generator for its first event before committing
      // to a 200, so early upstream failures can still fall through to the
      // next candidate.
      const gen = adapter.streamChat(cfg, upstream, req);
      const first = await gen.next();

      const id = completionId();
      const created = Math.floor(started / 1000);
      const chunk = (delta: object, finish: string | null) => ({
        id,
        object: "chat.completion.chunk",
        created,
        model: model.alias,
        choices: [{ index: 0, delta, finish_reason: finish }],
      });

      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const send = (frame: string) =>
            controller.enqueue(encoder.encode(frame));
          let usage: TokenUsage | null = null;
          let ok = false;
          try {
            send(sseFrame(chunk({ role: "assistant", content: "" }, null)));

            let event = first;
            while (!event.done) {
              const ev = event.value;
              if (ev.type === "delta") {
                send(sseFrame(chunk({ content: ev.text }, null)));
              } else if (ev.type === "progress") {
                // Non-standard field; OpenAI clients ignore it. It also keeps
                // proxies from timing out a long silent reasoning phase.
                send(
                  sseFrame({
                    ...chunk({}, null),
                    gateway_progress: { thinking_tokens: ev.thinkingTokens },
                  }),
                );
              } else {
                usage = ev.usage;
                send(sseFrame(chunk({}, ev.finishReason)));
                send(
                  sseFrame({
                    id,
                    object: "chat.completion.chunk",
                    created,
                    model: model.alias,
                    choices: [],
                    usage: {
                      prompt_tokens: ev.usage.promptTokens,
                      completion_tokens: ev.usage.completionTokens,
                      total_tokens:
                        ev.usage.promptTokens + ev.usage.completionTokens,
                    },
                  }),
                );
              }
              event = await gen.next();
            }
            send(SSE_DONE);
            ok = true;
          } catch (err) {
            // Mid-stream failure: headers already sent; emit an error frame.
            const msg =
              err instanceof Error ? err.message : "stream interrupted";
            send(sseFrame({ error: { message: msg, type: "upstream_error" } }));
          } finally {
            await writeLog({
              apiKey,
              candidate,
              requestedModel,
              routedReason,
              usage,
              latencyMs: Date.now() - started,
              status: ok ? "ok" : "error",
              stream: true,
              errorCode: ok ? undefined : "stream_interrupted",
            });
            controller.close();
          }
        },
      });

      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      });
    } catch (err) {
      const g =
        err instanceof GatewayError
          ? err
          : new GatewayError(String(err), 502, "upstream_error", true);
      lastError = g;
      await writeLog({
        apiKey,
        candidate,
        requestedModel,
        routedReason,
        usage: null,
        latencyMs: Date.now() - started,
        status: "error",
        stream: req.stream,
        errorCode: g.code,
        errorMsg: g.message,
      });
      // Explicit model choice, or a non-retryable error: stop here.
      if (reason === "explicit" || !g.retryable) throw g;
      // Otherwise fall through to the next candidate.
    }
  }

  throw lastError ?? new GatewayError("No models available", 503, "no_models");
}
