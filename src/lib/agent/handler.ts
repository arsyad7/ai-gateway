import type { ApiKey } from "@prisma/client";
import { errorResponse, parseImage } from "@/lib/gateway";
import { GatewayError } from "@/lib/types";
import { runAgentLoop } from "@/lib/agent/loop";
import type { AgentEvent, AgentHistoryMsg } from "@/lib/agent/types";
import { sseFrame, SSE_DONE } from "@/lib/providers/sse";

type AgentBody = {
  model?: string;
  task?: string;
  history?: AgentHistoryMsg[];
  /** Images attached to the task, as base64 data: URLs. */
  images?: string[];
  system?: string;
  max_iterations?: number;
  max_tokens?: number;
  stream?: boolean;
};

const MAX_HISTORY = 40;

/** Keeps only well-formed prior turns; anything else is a 400. */
function parseHistory(raw: unknown): AgentHistoryMsg[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    throw new GatewayError("'history' must be an array", 400, "invalid_request");
  }
  const out: AgentHistoryMsg[] = [];
  for (const m of raw) {
    const ok =
      m &&
      typeof m === "object" &&
      (m.role === "user" || m.role === "assistant") &&
      typeof m.content === "string";
    if (!ok) {
      throw new GatewayError(
        "'history' items must be { role: 'user' | 'assistant', content: string }",
        400,
        "invalid_request",
      );
    }
    if (m.content.trim()) out.push({ role: m.role, content: m.content });
  }
  // Oldest turns fall off first so a long chat cannot blow the context.
  return out.slice(-MAX_HISTORY);
}

const MAX_IMAGES = 10;

function parseImages(raw: unknown) {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw) || raw.some((u) => typeof u !== "string")) {
    throw new GatewayError("'images' must be an array of data: URL strings", 400, "invalid_request");
  }
  if (raw.length > MAX_IMAGES) {
    throw new GatewayError(`At most ${MAX_IMAGES} images per task`, 400, "invalid_request");
  }
  return raw.map((u) => parseImage(u as string));
}

/** Shared by /api/v1/agent (key auth) and /api/admin/agent (session auth). */
export async function handleAgentRequest(
  apiKey: ApiKey | null,
  body: AgentBody,
): Promise<Response> {
  if (!body.task || typeof body.task !== "string") {
    throw new GatewayError("'task' (string) is required", 400, "invalid_request");
  }
  const common = {
    apiKey,
    model: body.model,
    task: body.task,
    history: parseHistory(body.history),
    images: parseImages(body.images),
    system: body.system,
    maxIterations: body.max_iterations,
    maxTokensPerCall: body.max_tokens,
  };

  if (!body.stream) {
    const events: AgentEvent[] = [];
    const result = await runAgentLoop({
      ...common,
      emit: (e) => {
        if (e.type !== "done") events.push(e);
      },
    });
    return Response.json({ ...result, events });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (e: AgentEvent) =>
        controller.enqueue(encoder.encode(sseFrame(e)));
      try {
        await runAgentLoop({ ...common, emit: send });
      } catch (err) {
        const g =
          err instanceof GatewayError
            ? err
            : new GatewayError(
                err instanceof Error ? err.message : "agent failed",
                500,
                "agent_error",
              );
        send({ type: "error", message: g.message, code: g.code });
      } finally {
        controller.enqueue(encoder.encode(SSE_DONE));
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
}

export { errorResponse };
