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
import {
  estimateTokens,
  GatewayError,
  hasImages,
  messageImages,
  messageText,
  type ImagePart,
} from "@/lib/types";

/**
 * The CLI takes a text prompt, but its Read tool can view image files. Images
 * are written here under a content hash and referenced by path in the prompt;
 * requests that carry images run with Read enabled and this dir as cwd.
 */
const IMAGE_DIR = path.join(tmpdir(), "aicad-images");
const IMAGE_TTL_MS = 5 * 60_000;
const IMAGE_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

function imagePath(img: ImagePart): string {
  const id = createHash("sha256").update(img.data).digest("hex").slice(0, 20);
  return path.join(IMAGE_DIR, `${id}.${IMAGE_EXT[img.mediaType] ?? "png"}`);
}

/** Prompt lines pointing the CLI's Read tool at each image file. */
export function cliImageNote(images: ImagePart[]): string {
  return images
    .map((img, i) => `[Attached image ${i + 1}: ${imagePath(img)} — open it with the Read tool to view it]`)
    .join("\n");
}

function cliText(m: ChatMessage): string {
  const images = messageImages(m);
  const text = messageText(m);
  if (!images.length) return text;
  return `${text}\n\n${cliImageNote(images)}`;
}

/** Puts images on disk (idempotent, content-addressed) and tidies up later. */
export async function writeImageFiles(images: ImagePart[]): Promise<void> {
  if (!images.length) return;
  await fsp.mkdir(IMAGE_DIR, { recursive: true });
  for (const img of images) {
    const p = imagePath(img);
    await fsp.writeFile(p, Buffer.from(img.data, "base64"));
    setTimeout(() => fsp.unlink(p).catch(() => {}), IMAGE_TTL_MS).unref();
  }
}

function writeImages(req: NormalizedRequest): Promise<void> {
  return writeImageFiles(req.messages.flatMap(messageImages));
}

/**
 * System prompts are handed to the CLI as files (content-addressed, like the
 * images): a prompt on the command line would go through cmd.exe on Windows,
 * where newlines and quotes break and the whole line is capped at 8 KB.
 */
const SYSTEM_DIR = path.join(tmpdir(), "aicad-system");
const SYSTEM_TTL_MS = 30 * 60_000;

export async function systemPromptFile(system: string | undefined): Promise<string | undefined> {
  if (!system?.trim()) return undefined;
  await fsp.mkdir(SYSTEM_DIR, { recursive: true });
  const id = createHash("sha256").update(system).digest("hex").slice(0, 20);
  const p = path.join(SYSTEM_DIR, `${id}.txt`);
  await fsp.writeFile(p, system);
  setTimeout(() => fsp.unlink(p).catch(() => {}), SYSTEM_TTL_MS).unref();
  return p;
}

/**
 * The CLI runs in an empty directory rather than the gateway's own checkout,
 * so its cwd, git status and any CLAUDE.md there never reach the model.
 */
const NEUTRAL_CWD = path.join(tmpdir(), "aicad-cwd");
let neutralCwdReady: Promise<string> | undefined;
function neutralCwd(): Promise<string> {
  return (neutralCwdReady ??= fsp.mkdir(NEUTRAL_CWD, { recursive: true }).then(() => NEUTRAL_CWD));
}

/**
 * Routes chat completions through the local Claude Code CLI (`claude -p`),
 * so usage bills to the machine's Claude subscription instead of an API key.
 *
 * Provider config: apiKey is unused ("local"); baseUrl optionally overrides
 * the CLI command (default "claude"). Intended for personal/local gateways —
 * a Claude subscription is for personal use, don't resell this publicly.
 */

const CLI_TIMEOUT_MS = 280_000;
const MODEL_RE = /^[A-Za-z0-9._:-]+$/;
/** OpenAI `reasoning_effort` values mapped onto the CLI's --effort levels. */
const EFFORT: Record<string, string> = {
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

/**
 * Flattens the OpenAI-style conversation into a single prompt for -p mode.
 * The client's system prompt is not part of it: it goes to the CLI through
 * --system-prompt-file (see systemPromptFile), which replaces Claude Code's
 * own system prompt. Inlined as text it competed with that prompt, and the
 * model would sometimes keep its "Claude Code in <gateway dir>" identity and
 * tell the client its messages had gone to the wrong place.
 */
function buildPrompt(req: NormalizedRequest): string {
  const parts: string[] = [];
  const turns = req.messages.filter((m) => m.role !== "system");
  // A single user message goes through verbatim; longer histories become a
  // labeled transcript the model continues.
  if (turns.length === 1 && turns[0].role === "user") {
    return cliText(turns[0]);
  }
  for (const m of turns) {
    parts.push(`${m.role === "assistant" ? "Assistant" : "User"}: ${cliText(m)}`);
  }
  parts.push(
    "Continue this conversation as the assistant. Reply with the assistant's next message only.",
  );
  return parts.join("\n\n");
}

/**
 * Session resume. The OpenAI protocol is stateless (the client resends the
 * whole history, with no conversation id), so each finished turn is remembered
 * under a hash of the conversation so far. When the next request's history
 * matches, the CLI session is resumed and only the new user message is sent,
 * instead of replaying the full transcript into a brand-new session.
 */
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const SESSION_MAX = 500;
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type SessionEntry = { id: string; at: number };
// On globalThis so the maps survive dev-server module reloads.
const g = globalThis as typeof globalThis & {
  __cliSessions?: Map<string, SessionEntry>;
  __cliSessionHeads?: Map<string, string>;
};
const sessions = (g.__cliSessions ??= new Map<string, SessionEntry>());
/**
 * Session id -> key of that session's latest state. A request continuing from
 * the head resumes in place (one CLI session per conversation); one continuing
 * from an earlier point (edited message, regenerate) forks instead, because
 * the session already holds turns that branch never saw.
 */
const heads = (g.__cliSessionHeads ??= new Map<string, string>());

type Resume = { id: string; fork: boolean };

function convoKey(
  cfg: ProviderConfig,
  model: UpstreamModel,
  req: NormalizedRequest,
  turns: ChatMessage[],
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        cfg.baseUrl ?? "",
        model.upstreamModel,
        req.system ?? "",
        // Trimmed: clients often strip whitespace from the stored reply.
        turns.map((m) => [m.role, cliText(m).trim()]),
      ]),
    )
    .digest("hex");
}

type PromptPlan = { prompt: string; resume?: Resume; key?: string };

function forgetSession(key: string): void {
  const entry = sessions.get(key);
  if (entry && heads.get(entry.id) === key) heads.delete(entry.id);
  sessions.delete(key);
}

/** Resume a known session with just the new message, else replay everything. */
function planPrompt(
  cfg: ProviderConfig,
  model: UpstreamModel,
  req: NormalizedRequest,
): PromptPlan {
  const turns = req.messages.filter((m) => m.role !== "system");
  const last = turns[turns.length - 1];
  if (turns.length >= 3 && last.role === "user" && turns[turns.length - 2].role === "assistant") {
    const key = convoKey(cfg, model, req, turns.slice(0, -1));
    const entry = sessions.get(key);
    if (entry && Date.now() - entry.at < SESSION_TTL_MS) {
      const fork = heads.get(entry.id) !== key;
      // Claim the head now, so a concurrent request on the same state forks.
      if (!fork) heads.delete(entry.id);
      return { prompt: cliText(last), resume: { id: entry.id, fork }, key };
    }
    if (entry) forgetSession(key);
  }
  return { prompt: buildPrompt(req) };
}

function rememberSession(
  cfg: ProviderConfig,
  model: UpstreamModel,
  req: NormalizedRequest,
  reply: string,
  sessionId: string | undefined,
): void {
  if (!sessionId || !SESSION_ID_RE.test(sessionId) || !reply) return;
  const turns = req.messages.filter((m) => m.role !== "system");
  const key = convoKey(cfg, model, req, [...turns, { role: "assistant", content: reply }]);
  sessions.delete(key);
  sessions.set(key, { id: sessionId, at: Date.now() });
  heads.set(sessionId, key);
  // Map keeps insertion order, so the first key is the oldest.
  while (sessions.size > SESSION_MAX) {
    forgetSession(sessions.keys().next().value as string);
  }
}

function cliArgs(
  model: UpstreamModel,
  outputFormat: string,
  reasoningEffort?: string,
  resume?: Resume,
  withImages = false,
  systemFile?: string,
): string[] {
  if (!MODEL_RE.test(model.upstreamModel)) {
    throw new GatewayError(
      `invalid claude_cli model name '${model.upstreamModel}'`,
      400,
      "invalid_model",
    );
  }
  const args = [
    "-p",
    "--output-format",
    outputFormat,
    "--model",
    model.upstreamModel,
    // The gateway is a plain text-completion endpoint: with Claude Code's own
    // tools left on, the model tries to use them (reading/editing files on the
    // gateway host) and the single turn ends in error_max_turns with no text.
    // '""' survives the shell as an empty argument = no built-in tools. With
    // images attached, only Read is allowed (to view them) plus a few turns.
    "--max-turns",
    withImages ? "4" : "1",
    "--tools",
    withImages ? "Read" : '""',
    "--strict-mcp-config",
    // Host isolation: a gateway client must never reach files or commands on
    // the machine running the CLI. Built-in tools are off (Read only for
    // images, and it is confined to the image dir: reads elsewhere need a
    // permission grant that -p mode has nobody to give). No MCP servers, no
    // user/project settings (so no hooks, plugins or allow rules from this
    // machine), and anything that would ask for permission is denied.
    "--setting-sources",
    '""',
    "--permission-mode",
    "dontAsk",
  ];
  // Replaces Claude Code's default system prompt (identity, cwd, env info)
  // with the client's. The path is under tmpdir with a hex name: shell-safe.
  if (systemFile) args.push("--system-prompt-file", systemFile);
  // Partial messages give token-level deltas instead of one block at the end.
  if (outputFormat === "stream-json") args.push("--verbose", "--include-partial-messages");
  // Looked up in a fixed table, so nothing caller-supplied reaches the shell.
  const effort = reasoningEffort && EFFORT[reasoningEffort.toLowerCase()];
  if (effort) args.push("--effort", effort);
  // The id is UUID-checked, so it is safe to hand to the shell.
  if (resume && SESSION_ID_RE.test(resume.id)) {
    args.push("--resume", resume.id);
    if (resume.fork) args.push("--fork-session");
  }
  return args;
}

type CliProc = {
  stdout: NodeJS.ReadableStream;
  wait: Promise<{ code: number; stderr: string }>;
};

function runCli(cfg: ProviderConfig, args: string[], prompt: string, cwd?: string): CliProc {
  const command = cfg.baseUrl?.trim() || "claude";
  // shell:true so the npm .cmd shim resolves on Windows; args are all
  // fixed flags or a validated model name, and the prompt goes via stdin.
  const child = spawn(command, args, { shell: true, windowsHide: true, cwd });

  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  child.stdin.on("error", () => {}); // ignore EPIPE if the CLI exits early
  child.stdin.write(prompt);
  child.stdin.end();

  const timer = setTimeout(() => child.kill(), CLI_TIMEOUT_MS);
  const wait = new Promise<{ code: number; stderr: string }>((resolve, reject) => {
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(
        new GatewayError(
          `failed to start claude CLI ('${command}'): ${err.message}`,
          502,
          "cli_spawn_failed",
          true,
        ),
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stderr });
    });
  });

  return { stdout: child.stdout, wait };
}

type CliUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

function mapUsage(u: CliUsage | undefined): TokenUsage {
  const cached = u?.cache_read_input_tokens ?? 0;
  const cacheWrite = u?.cache_creation_input_tokens ?? 0;
  return {
    promptTokens: (u?.input_tokens ?? 0) + cached + cacheWrite,
    completionTokens: u?.output_tokens ?? 0,
    cachedReadTokens: cached,
    cacheWriteTokens: cacheWrite,
  };
}

function mapStop(reason: string | undefined): string {
  if (reason === "max_tokens") return "length";
  if (reason === "refusal") return "content_filter";
  return "stop";
}

/** The CLI's error results often carry no text, only a subtype. */
function cliErrorText(ev: { result?: unknown; subtype?: string }): string {
  return String(ev.result ?? ev.subtype ?? "unknown error").slice(0, 400);
}

/** One non-streaming `claude -p` run; also drives the agent loop. */
export async function cliComplete(
  cfg: ProviderConfig,
  model: UpstreamModel,
  prompt: string,
  reasoningEffort?: string,
  resume?: Resume,
  withImages = false,
  system?: string,
): Promise<ChatResult & { sessionId?: string }> {
  const proc = runCli(
    cfg,
    cliArgs(model, "json", reasoningEffort, resume, withImages, await systemPromptFile(system)),
    prompt,
    withImages ? IMAGE_DIR : await neutralCwd(),
  );
  let out = "";
  proc.stdout.on("data", (d) => (out += d));
  const { code, stderr } = await proc.wait;

  if (code !== 0 && !out.trim()) {
    throw new GatewayError(
      `claude CLI exited with code ${code}: ${stderr.slice(0, 400) || "no output"}`,
      502,
      "cli_failed",
      true,
    );
  }
  let json: {
    result?: string;
    subtype?: string;
    is_error?: boolean;
    stop_reason?: string;
    usage?: CliUsage;
    session_id?: string;
  };
  try {
    json = JSON.parse(out);
  } catch {
    throw new GatewayError(
      `claude CLI returned non-JSON output: ${out.slice(0, 200)}`,
      502,
      "cli_bad_output",
    );
  }
  if (json.is_error) {
    throw new GatewayError(
      `claude CLI error: ${cliErrorText(json)}`,
      502,
      "cli_error",
      true,
    );
  }
  return {
    text: json.result ?? "",
    finishReason: mapStop(json.stop_reason),
    usage: mapUsage(json.usage),
    sessionId: json.session_id,
  };
}

export const claudeCliAdapter: ProviderAdapter = {
  kind: "claude_cli",

  async chat(cfg, model, req): Promise<ChatResult> {
    const plan = planPrompt(cfg, model, req);
    const images = hasImages(req.messages);
    await writeImages(req);
    let res: ChatResult & { sessionId?: string };
    try {
      res = await cliComplete(
        cfg,
        model,
        plan.prompt,
        req.reasoningEffort,
        plan.resume,
        images,
        req.system,
      );
    } catch (err) {
      // The session may be gone (cleaned up, other machine): replay in full.
      if (!plan.resume) throw err;
      forgetSession(plan.key!);
      res = await cliComplete(
        cfg,
        model,
        buildPrompt(req),
        req.reasoningEffort,
        undefined,
        images,
        req.system,
      );
    }
    const { sessionId, ...result } = res;
    rememberSession(cfg, model, req, result.text, sessionId);
    return result;
  },

  async *streamChat(cfg, model, req): AsyncGenerator<StreamEvent> {
    const plan = planPrompt(cfg, model, req);
    const meta: StreamMeta = { emitted: "" };
    // Remembered before "done" goes out: the client may send its next request
    // (or stop reading) the moment it sees the final chunk.
    const remember = () => rememberSession(cfg, model, req, meta.emitted, meta.sessionId);
    await writeImages(req);
    try {
      yield* streamOnce(cfg, model, req, plan.prompt, meta, remember, plan.resume);
    } catch (err) {
      // Same fallback as chat(), but only while nothing has reached the client.
      if (!plan.resume || meta.emitted) throw err;
      forgetSession(plan.key!);
      yield* streamOnce(cfg, model, req, buildPrompt(req), meta, remember);
    }
  },
};

type StreamMeta = { emitted: string; sessionId?: string };

async function* streamOnce(
  cfg: ProviderConfig,
  model: UpstreamModel,
  req: NormalizedRequest,
  prompt: string,
  meta: StreamMeta,
  onFinished: () => void,
  resume?: Resume,
): AsyncGenerator<StreamEvent> {
  {
    const images = hasImages(req.messages);
    const proc = runCli(
      cfg,
      cliArgs(
        model,
        "stream-json",
        req.reasoningEffort,
        resume,
        images,
        await systemPromptFile(req.system),
      ),
      prompt,
      images ? IMAGE_DIR : await neutralCwd(),
    );

    // Collect NDJSON lines as they arrive; emit text deltas as they stream.
    let buffer = "";
    let sawDelta = false;
    let usage: TokenUsage | null = null;
    let stop: string | undefined;

    const lines: string[] = [];
    let notify: (() => void) | null = null;
    let ended = false;
    proc.stdout.on("data", (d) => {
      buffer += d;
      let idx: number;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        lines.push(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 1);
      }
      notify?.();
    });
    const done = proc.wait.then((r) => {
      ended = true;
      if (buffer.trim()) lines.push(buffer);
      notify?.();
      return r;
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

    for (;;) {
      const line = await nextLine();
      if (line === null) break;
      if (!line.trim()) continue;
      let ev: {
        type?: string;
        estimated_tokens?: number;
        event?: { type?: string; delta?: { type?: string; text?: string } };
        message?: { content?: { type: string; text?: string }[] };
        result?: string;
        subtype?: string;
        is_error?: boolean;
        stop_reason?: string;
        usage?: CliUsage;
        session_id?: string;
      };
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (ev.type === "system" && ev.subtype === "thinking_tokens") {
        yield { type: "progress", thinkingTokens: ev.estimated_tokens ?? 0 };
      } else if (ev.type === "stream_event") {
        const d = ev.event?.delta;
        if (ev.event?.type === "content_block_delta" && d?.type === "text_delta" && d.text) {
          sawDelta = true;
          meta.emitted += d.text;
          yield { type: "delta", text: d.text };
        }
      } else if (ev.type === "assistant" && !sawDelta) {
        // Older CLIs without partial messages: whole blocks only.
        for (const block of ev.message?.content ?? []) {
          if (block.type === "text" && block.text) {
            meta.emitted += block.text;
            yield { type: "delta", text: block.text };
          }
        }
      } else if (ev.type === "result") {
        if (ev.is_error) {
          throw new GatewayError(
            `claude CLI error: ${cliErrorText(ev)}`,
            502,
            "cli_error",
            true,
          );
        }
        usage = mapUsage(ev.usage);
        stop = ev.stop_reason;
        meta.sessionId = ev.session_id;
      }
    }

    const { code, stderr } = await done;
    if (!usage && code !== 0) {
      throw new GatewayError(
        `claude CLI exited with code ${code}: ${stderr.slice(0, 400) || "no output"}`,
        502,
        "cli_failed",
        true,
      );
    }
    onFinished();
    yield {
      type: "done",
      finishReason: mapStop(stop),
      usage:
        usage ?? {
          promptTokens: estimateTokens(prompt),
          completionTokens: estimateTokens(meta.emitted),
          estimated: true,
        },
    };
  }
}
