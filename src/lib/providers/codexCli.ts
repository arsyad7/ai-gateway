import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  ChatMessage,
  ChatResult,
  NormalizedRequest,
  ProviderAdapter,
  ProviderConfig,
  StreamEvent,
  TokenUsage,
  UpstreamModel,
} from "@/lib/types";
import { estimateTokens, GatewayError, messageImages, messageText, type ImagePart } from "@/lib/types";

/**
 * OpenAI Codex CLI as a provider: `codex exec --json` run with the user's own
 * ChatGPT login, so no API key is involved. Like the Claude CLI adapter this
 * is a plain text completion: the transcript is replayed as one prompt and
 * the CLI's sandbox is read-only inside an empty scratch directory. Images
 * are attached natively with `-i`.
 */

const MODEL_RE = /^[a-zA-Z0-9._-]{1,64}$/;
const EFFORT: Record<string, string> = {
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "xhigh",
};
const WORK_DIR = path.join(tmpdir(), "aicad-codex");
const IMAGE_TTL_MS = 5 * 60_000;
const IMAGE_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

function turnText(m: ChatMessage): string {
  const n = messageImages(m).length;
  const text = messageText(m);
  return n ? `${text}\n[${n} image${n === 1 ? "" : "s"} attached to this prompt]` : text;
}

/** Whole conversation as one prompt; the CLI is stateless between calls. */
export function codexPrompt(req: NormalizedRequest): string {
  const parts: string[] = [];
  if (req.system) parts.push(`<system instructions>\n${req.system}\n</system instructions>`);
  const turns = req.messages.filter((m) => m.role !== "system");
  if (turns.length === 1 && turns[0].role === "user" && !req.system) {
    return turnText(turns[0]);
  }
  for (const m of turns) {
    parts.push(`${m.role === "assistant" ? "Assistant" : "User"}: ${turnText(m)}`);
  }
  parts.push(
    "Continue this conversation as the assistant. Reply with the assistant's next message only.",
  );
  return parts.join("\n\n");
}

/** Writes images to the scratch dir (content-addressed) for `-i`. */
export async function codexImageFiles(images: ImagePart[]): Promise<string[]> {
  if (!images.length) return [];
  await fsp.mkdir(WORK_DIR, { recursive: true });
  const files: string[] = [];
  for (const img of images) {
    const id = createHash("sha256").update(img.data).digest("hex").slice(0, 20);
    const p = path.join(WORK_DIR, `${id}.${IMAGE_EXT[img.mediaType] ?? "png"}`);
    await fsp.writeFile(p, Buffer.from(img.data, "base64"));
    setTimeout(() => fsp.unlink(p).catch(() => {}), IMAGE_TTL_MS).unref();
    files.push(p);
  }
  return files;
}

/** Quotes a path for the shell (spawn uses shell:true so the npm shim resolves). */
const q = (s: string) => `"${s.replace(/"/g, "")}"`;

function codexArgs(
  model: UpstreamModel,
  reasoningEffort: string | undefined,
  images: string[],
  lastMessageFile: string,
): string[] {
  if (!MODEL_RE.test(model.upstreamModel)) {
    throw new GatewayError(
      `invalid codex_cli model name '${model.upstreamModel}'`,
      400,
      "invalid_model",
    );
  }
  const args = [
    "exec",
    "--json",
    "--ephemeral",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "-C",
    q(WORK_DIR),
    "-m",
    model.upstreamModel,
    "-o",
    q(lastMessageFile),
  ];
  const effort = reasoningEffort && EFFORT[reasoningEffort.toLowerCase()];
  if (effort) args.push("-c", `model_reasoning_effort=${effort}`);
  if (images.length) args.push("-i", ...images.map(q));
  // "--" ends the variadic -i list; "-" reads the prompt from stdin.
  args.push("--", "-");
  return args;
}

type CodexEvent = {
  type?: string;
  message?: string;
  item?: { type?: string; text?: string; message?: string };
  usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number };
  error?: { message?: string };
};

type RunResult = {
  text: string;
  usage: TokenUsage;
  reasoningChars: number;
};

/**
 * Runs one `codex exec` and streams parsed events. The CLI reports whole
 * items, not token deltas, so text arrives one assistant message at a time.
 */
async function* runCodex(
  cfg: ProviderConfig,
  model: UpstreamModel,
  req: NormalizedRequest,
): AsyncGenerator<StreamEvent, RunResult> {
  await fsp.mkdir(WORK_DIR, { recursive: true });
  const images = await codexImageFiles(req.messages.flatMap(messageImages));
  const lastFile = path.join(WORK_DIR, `last-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
  const prompt = codexPrompt(req);
  const command = cfg.baseUrl?.trim() || "codex";
  const child = spawn(command, codexArgs(model, req.reasoningEffort, images, lastFile), {
    shell: true,
    windowsHide: true,
    cwd: WORK_DIR,
  });

  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  child.stdin.on("error", () => {});
  child.stdin.end(prompt);

  // Line queue bridging the child's stdout to this generator.
  const lines: string[] = [];
  let buffer = "";
  let notify: (() => void) | null = null;
  let ended = false;
  let exitCode = 0;
  child.stdout.on("data", (d) => {
    buffer += d;
    let idx: number;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      lines.push(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 1);
    }
    notify?.();
  });
  const exited = new Promise<void>((resolve) => {
    child.on("error", (err) => {
      stderr += String(err);
      exitCode = -1;
      ended = true;
      notify?.();
      resolve();
    });
    child.on("close", (code) => {
      exitCode = code ?? 0;
      if (buffer.trim()) lines.push(buffer);
      ended = true;
      notify?.();
      resolve();
    });
  });
  const nextLine = async (): Promise<string | null> => {
    for (;;) {
      const line = lines.shift();
      if (line !== undefined) return line;
      if (ended) return null;
      await new Promise<void>((r) => (notify = r));
      notify = null;
    }
  };

  const texts: string[] = [];
  let usage: TokenUsage | null = null;
  let failure: string | null = null;
  let reasoningChars = 0;

  for (;;) {
    const line = await nextLine();
    if (line === null) break;
    if (!line.trim()) continue;
    let ev: CodexEvent;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type === "item.completed" && ev.item?.type === "agent_message" && ev.item.text) {
      texts.push(ev.item.text);
      yield { type: "delta", text: (texts.length > 1 ? "\n\n" : "") + ev.item.text };
    } else if (ev.type === "item.completed" && ev.item?.type === "reasoning" && ev.item.text) {
      reasoningChars += ev.item.text.length;
      yield { type: "progress", thinkingTokens: Math.ceil(reasoningChars / 4) };
    } else if (ev.type === "turn.completed" && ev.usage) {
      const cached = ev.usage.cached_input_tokens ?? 0;
      usage = {
        promptTokens: ev.usage.input_tokens ?? 0,
        completionTokens: ev.usage.output_tokens ?? 0,
        cachedReadTokens: cached,
      };
    } else if (ev.type === "turn.failed") {
      failure = ev.error?.message ?? "turn failed";
    } else if (ev.type === "error" && ev.message && !/^Reconnecting/i.test(ev.message)) {
      // Transient reconnects are noise; anything else is the real reason.
      failure = failure ?? ev.message;
    }
  }
  await exited;

  // The CLI writes the final assistant message here; trust it over our
  // concatenation when both exist.
  let text = texts.join("\n\n");
  try {
    const last = (await fsp.readFile(lastFile, "utf8")).trim();
    if (last) text = last;
  } catch {
    /* no final message written */
  }
  fsp.unlink(lastFile).catch(() => {});

  if (failure) {
    throw new GatewayError(`codex CLI error: ${failure.slice(0, 400)}`, 502, "codex_error", true);
  }
  if (!text) {
    throw new GatewayError(
      `codex CLI exited with code ${exitCode} and no reply: ${stderr.slice(0, 400) || "no output"}`,
      502,
      "codex_failed",
      true,
    );
  }
  return {
    text,
    usage: usage ?? {
      promptTokens: estimateTokens(prompt),
      completionTokens: estimateTokens(text),
      estimated: true,
    },
    reasoningChars,
  };
}

/** Non-streaming text completion for the agent loop and direct callers. */
export async function codexComplete(
  cfg: ProviderConfig,
  model: UpstreamModel,
  req: NormalizedRequest,
): Promise<ChatResult> {
  const gen = runCodex(cfg, model, req);
  for (;;) {
    const next = await gen.next();
    if (next.done) {
      return { text: next.value.text, finishReason: "stop", usage: next.value.usage };
    }
  }
}

export const codexCliAdapter: ProviderAdapter = {
  kind: "codex_cli",

  chat(cfg, model, req): Promise<ChatResult> {
    return codexComplete(cfg, model, req);
  },

  async *streamChat(cfg, model, req): AsyncGenerator<StreamEvent> {
    const gen = runCodex(cfg, model, req);
    let emittedAny = false;
    for (;;) {
      const next = await gen.next();
      if (next.done) {
        // If the final message file differed from what streamed (rare), the
        // client already has the streamed text; usage is what matters here.
        if (!emittedAny && next.value.text) yield { type: "delta", text: next.value.text };
        yield { type: "done", finishReason: "stop", usage: next.value.usage };
        return;
      }
      if (next.value.type === "delta") emittedAny = true;
      yield next.value;
    }
  },
};
