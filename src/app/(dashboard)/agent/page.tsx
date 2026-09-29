"use client";

import { useEffect, useRef, useState } from "react";
import { api, compact, PageHeader, usd } from "@/components/ui";
import { Markdown } from "@/components/markdown";

type ModelRow = { alias: string; enabled: boolean };

type Event =
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

type DoneEvent = Extract<Event, { type: "done" }>;

/** One exchange: the user's task and everything the agent did for it. */
type Turn = {
  id: string;
  task: string;
  /** Thumbnails of the images sent with the task. */
  images?: string[];
  /** Names of text files inlined into the task. */
  files?: string[];
  events: Event[];
  done?: DoneEvent;
  error?: string;
  stopped?: boolean;
};

type Attachment =
  | { id: number; kind: "image"; name: string; dataUrl: string }
  | { id: number; kind: "text"; name: string; text: string };

const MAX_SIDE = 1568; // longest image edge sent to the model
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TEXT_BYTES = 200 * 1024;
let attachSeq = 0;

/** Screenshots are scaled down client-side; models gain nothing above ~1.5k px. */
function shrinkImage(dataUrl: string, mime: string): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
      const tooBig = dataUrl.length * 0.75 > MAX_IMAGE_BYTES;
      if (scale === 1 && !tooBig) return resolve(dataUrl);
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext("2d")?.drawImage(img, 0, 0, c.width, c.height);
      resolve(c.toDataURL(mime === "image/png" && !tooBig ? "image/png" : "image/jpeg", 0.9));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result as string);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

function langOf(name: string): string {
  const ext = (name.split(".").pop() ?? "").toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(ext) ? ext : "";
}

const EXAMPLES = [
  "Fetch https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd and convert 0.5 BTC to IDR at 16,500 per USD",
  "What is 17.5% of 2,340,000, then split it evenly across 7 people?",
  "Fetch https://api.github.com/repos/vercel/next.js and summarise the repo in three bullets",
];

export default function AgentPage() {
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState("auto");
  const [maxIter, setMaxIter] = useState(8);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  async function addFiles(list: FileList | File[]) {
    const added: Attachment[] = [];
    const skipped: string[] = [];
    for (const file of Array.from(list)) {
      const name = file.name || (file.type.startsWith("image/") ? "screenshot.png" : "pasted.txt");
      if (file.type.startsWith("image/")) {
        const dataUrl = await shrinkImage(await readAsDataUrl(file), file.type);
        if (dataUrl.length * 0.75 > MAX_IMAGE_BYTES) {
          skipped.push(`${name} (over 5 MB after resizing)`);
          continue;
        }
        added.push({ id: ++attachSeq, kind: "image", name, dataUrl });
      } else if (file.size <= MAX_TEXT_BYTES) {
        const text = await file.text();
        if (text.includes("\u0000")) {
          skipped.push(`${name} (binary; only images and text files can be attached)`);
          continue;
        }
        added.push({ id: ++attachSeq, kind: "text", name, text });
      } else {
        skipped.push(`${name} (text files must be under 200 KB)`);
      }
    }
    if (added.length) setAttachments((prev) => [...prev, ...added]);
    setNotice(skipped.length ? `Skipped ${skipped.join(", ")}` : null);
    textareaRef.current?.focus();
  }

  useEffect(() => {
    api<ModelRow[]>("/api/admin/models")
      .then((rows) => setModels(rows.filter((m) => m.enabled).map((m) => m.alias)))
      .catch(() => {});
  }, []);

  // Follow new content only while the reader is already near the bottom, so
  // scrolling up to re-read an earlier step is never yanked away.
  useEffect(() => {
    const nearBottom =
      window.innerHeight + window.scrollY >= document.body.scrollHeight - 240;
    if (nearBottom) bottomRef.current?.scrollIntoView({ block: "end" });
  }, [turns]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(200, el.scrollHeight) + "px";
  }, [input]);

  const updateLast = (fn: (t: Turn) => Turn) =>
    setTurns((prev) =>
      prev.length ? [...prev.slice(0, -1), fn(prev[prev.length - 1])] : prev,
    );

  async function send(text?: string) {
    const typed = (text ?? input).trim();
    if ((!typed && !attachments.length) || running) return;
    setInput("");
    setNotice(null);

    // Text files ride along inside the task; images go as a separate field.
    const textFiles = attachments.filter((a) => a.kind === "text");
    const imageAtts = attachments.filter((a) => a.kind === "image");
    let task = typed;
    for (const f of textFiles) {
      if (f.kind !== "text") continue;
      task += `${task ? "\n\n" : ""}File \`${f.name}\`:\n\`\`\`${langOf(f.name)}\n${f.text}\n\`\`\``;
    }
    if (!task && imageAtts.length) {
      task = `Look at the attached image${imageAtts.length > 1 ? "s" : ""} and describe what you see.`;
    }
    const images = imageAtts.map((a) => (a.kind === "image" ? a.dataUrl : "")).filter(Boolean);
    setAttachments([]);

    // Completed turns become context, so the new task can be a follow-up.
    const history = turns
      .filter((t) => t.done)
      .flatMap((t) => [
        { role: "user" as const, content: t.task },
        { role: "assistant" as const, content: t.done!.answer },
      ]);

    setTurns((prev) => [
      ...prev,
      {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        task: typed || task,
        images: images.length ? images : undefined,
        files: textFiles.length ? textFiles.map((f) => f.name) : undefined,
        events: [],
      },
    ]);
    setRunning(true);
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch("/api/admin/agent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model,
          task,
          images: images.length ? images : undefined,
          history,
          max_iterations: maxIter,
          stream: true,
        }),
        signal: controller.signal,
      });
      if (res.status === 401) {
        window.location.href = "/login";
        return;
      }
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => null);
        updateLast((t) => ({ ...t, error: body?.error?.message ?? `HTTP ${res.status}` }));
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, idx).replace(/\r$/, "");
          buffer = buffer.slice(idx + 1);
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          let ev: Event;
          try {
            ev = JSON.parse(payload) as Event;
          } catch {
            continue; // partial frame
          }
          if (ev.type === "done") updateLast((t) => ({ ...t, done: ev as DoneEvent }));
          else if (ev.type === "error") {
            const e = ev;
            updateLast((t) => ({ ...t, error: `${e.message} (${e.code})` }));
          } else updateLast((t) => ({ ...t, events: [...t.events, ev] }));
        }
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        updateLast((t) => ({ ...t, stopped: true }));
      } else {
        updateLast((t) => ({ ...t, error: (err as Error).message }));
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
      textareaRef.current?.focus();
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  function newChat() {
    if (running) stop();
    setTurns([]);
    setInput("");
    setAttachments([]);
    setNotice(null);
    textareaRef.current?.focus();
  }

  const spent = turns.reduce(
    (acc, t) => {
      if (!t.done) return acc;
      acc.tokens += t.done.usage.promptTokens + t.done.usage.completionTokens;
      acc.cost += t.done.usage.costUsd;
      return acc;
    },
    { tokens: 0, cost: 0 },
  );

  return (
    <div className="flex flex-col gap-5" style={{ minHeight: "calc(100vh - 6rem)" }}>
      <PageHeader
        title="Agent"
        description={
          <>
            A server-side agent loop: the model plans, calls tools (<code>http_fetch</code>,{" "}
            <code>calculator</code>), reads the results, and repeats until the task is done.
            Follow-up messages keep the conversation context.
          </>
        }
        actions={
          <>
            <label className="text-xs flex items-center gap-1.5" style={{ color: "var(--text-muted)" }}>
              Model
              <select
                className="input"
                style={{ width: "auto", padding: "4px 8px", fontSize: 13 }}
                value={model}
                onChange={(e) => setModel(e.target.value)}
              >
                <option value="auto">auto (cheapest with budget)</option>
                {models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs flex items-center gap-1.5" style={{ color: "var(--text-muted)" }}>
              Max steps
              <input
                className="input"
                type="number"
                min={1}
                max={25}
                value={maxIter}
                onChange={(e) => setMaxIter(Number(e.target.value))}
                style={{ width: 64, padding: "4px 8px", fontSize: 13 }}
              />
            </label>
            {turns.length > 0 && (
              <button type="button" className="btn-ghost" onClick={newChat}>
                New chat
              </button>
            )}
          </>
        }
      />

      <div className="flex-1 flex flex-col gap-4">
        {turns.length === 0 ? (
          <EmptyThread onPick={(t) => setInput(t)} />
        ) : (
          turns.map((turn, i) => (
            <div key={turn.id} className="flex flex-col gap-3 fade-in">
              <div className="flex flex-col items-end gap-1.5">
                {turn.images && (
                  <div className="agent-user-imgs">
                    {turn.images.map((src, j) => (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img key={j} src={src} alt="attached" onClick={(e) => e.currentTarget.classList.toggle("big")} />
                    ))}
                  </div>
                )}
                {turn.files && (
                  <div className="agent-user-files">
                    {turn.files.map((n) => (
                      <span key={n}>{n}</span>
                    ))}
                  </div>
                )}
                {turn.task && <div className="agent-user">{turn.task}</div>}
              </div>
              <AgentTurn turn={turn} live={running && i === turns.length - 1} />
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>

      <div className="agent-composer">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
          className={"card p-2 agent-form" + (dragging ? " drag" : "")}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
          }}
        >
          {attachments.length > 0 && (
            <div className="agent-att-row">
              {attachments.map((a) => (
                <div key={a.id} className="agent-att" title={a.name}>
                  {a.kind === "image" ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={a.dataUrl} alt={a.name} />
                  ) : (
                    <span className="agent-att-icon">TXT</span>
                  )}
                  <span className="agent-att-name">{a.name}</span>
                  <button
                    type="button"
                    className="agent-att-rm"
                    aria-label={`Remove ${a.name}`}
                    onClick={() => setAttachments((prev) => prev.filter((x) => x.id !== a.id))}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="flex items-end gap-2">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/*,.txt,.md,.json,.csv,.log,.ts,.tsx,.js,.jsx,.py,.go,.rs,.java,.cs,.html,.css,.yml,.yaml,.xml,.sh,.sql"
              hidden
              onChange={(e) => {
                if (e.target.files?.length) addFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <button
              type="button"
              className="agent-attach-btn"
              title="Attach images or text files (paste a screenshot or drop files here too)"
              aria-label="Attach files"
              onClick={() => fileInputRef.current?.click()}
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m21.4 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
              </svg>
            </button>
            <textarea
              ref={textareaRef}
              className="input agent-input"
              rows={1}
              placeholder={
                turns.length ? "Ask a follow-up…" : "Describe a task for the agent…"
              }
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onPaste={(e) => {
                const files = Array.from(e.clipboardData.files);
                if (files.length) {
                  e.preventDefault();
                  addFiles(files);
                }
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
                if (e.key === "Escape" && running) stop();
              }}
            />
            {running ? (
              <button type="button" className="btn-ghost" onClick={stop} style={{ padding: "7px 14px" }}>
                Stop
              </button>
            ) : (
              <button className="btn" disabled={!input.trim() && !attachments.length}>
                Send
              </button>
            )}
          </div>
        </form>
        {notice && (
          <div className="text-[11px] mt-1.5 px-1" style={{ color: "var(--status-warning)" }}>
            {notice}
          </div>
        )}
        <div
          className="flex flex-wrap justify-between gap-2 text-[11px] mt-1.5 px-1"
          style={{ color: "var(--text-muted)" }}
        >
          <span>Enter to send · Shift+Enter for a new line · Esc to stop · paste or drop images</span>
          {spent.tokens > 0 && (
            <span>
              This chat: {compact(spent.tokens)} tokens · {usd(spent.cost)}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function EmptyThread({ onPick }: { onPick: (task: string) => void }) {
  return (
    <div className="card p-6 sm:p-8 fade-in">
      <div className="text-base font-semibold">What should the agent do?</div>
      <p className="text-sm mt-1 mb-4" style={{ color: "var(--text-secondary)" }}>
        Give it a task that needs live data or exact numbers. It will fetch, compute, and
        explain, showing every step it took along the way.
      </p>
      <div className="grid gap-2 sm:grid-cols-3">
        {EXAMPLES.map((t) => (
          <button key={t} type="button" className="agent-example" onClick={() => onPick(t)}>
            {t}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Where the agent is right now, from the newest event. */
function statusText(events: Event[]): string {
  const last = events[events.length - 1];
  if (!last) return "Starting…";
  switch (last.type) {
    case "start":
    case "iteration":
      return `Thinking · step ${events.filter((e) => e.type === "iteration").length} · ${last.model}`;
    case "tool_call":
      return `Running ${last.name}…`;
    case "tool_result":
      return `Reading the result of ${last.name}…`;
    case "model_switch":
      return `Switched to ${last.to}, continuing…`;
    default:
      return "Thinking…";
  }
}

function AgentTurn({ turn, live }: { turn: Turn; live: boolean }) {
  const [copied, setCopied] = useState(false);
  const [openOverride, setOpenOverride] = useState<boolean | null>(null);
  const finished = Boolean(turn.done || turn.error || turn.stopped);
  // Steps stay open while the agent works, then fold away once the answer is in.
  const stepsOpen = openOverride ?? !finished;

  const steps = turn.events.filter(
    (ev) => ev.type !== "start" && ev.type !== "done" && ev.type !== "error",
  );
  // The loop emits the final text as an assistant event and again in `done`;
  // show it once, as the answer.
  const answer = turn.done?.answer.trim();
  let lastAssistant = -1;
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i].type === "assistant") {
      lastAssistant = i;
      break;
    }
  }
  const visibleSteps =
    answer !== undefined &&
    lastAssistant >= 0 &&
    (steps[lastAssistant] as { text: string }).text.trim() === answer
      ? steps.filter((_, i) => i !== lastAssistant)
      : steps;

  const iterations = turn.events.filter((e) => e.type === "iteration").length;
  const toolCalls = turn.events.filter((e) => e.type === "tool_call").length;

  async function copy() {
    if (!turn.done) return;
    try {
      await navigator.clipboard.writeText(turn.done.answer);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard unavailable */
    }
  }

  return (
    <div className="card p-4 sm:p-5">
      {visibleSteps.length > 0 && (
        <div className="agent-steps">
          <button
            type="button"
            className="agent-steps-toggle"
            onClick={() => setOpenOverride(!stepsOpen)}
            aria-expanded={stepsOpen}
          >
            <span className={"agent-chev" + (stepsOpen ? " open" : "")} aria-hidden>
              ▸
            </span>
            <span>
              {iterations} step{iterations === 1 ? "" : "s"} · {toolCalls} tool call
              {toolCalls === 1 ? "" : "s"}
            </span>
            {!finished && <span className="agent-spinner ml-auto" aria-hidden />}
          </button>
          {stepsOpen && (
            <ol className="agent-steps-list">
              {visibleSteps.map((ev, i) => (
                <li key={i}>
                  <Step ev={ev} />
                </li>
              ))}
            </ol>
          )}
        </div>
      )}

      {turn.done && <Markdown>{turn.done.answer}</Markdown>}

      {turn.error && <div className="agent-error">{turn.error}</div>}

      {turn.stopped && !turn.done && (
        <div className="text-sm" style={{ color: "var(--text-muted)" }}>
          Stopped before the agent finished.
        </div>
      )}

      {live && !turn.done && !turn.error && (
        <div className="flex items-center gap-2 text-sm" style={{ color: "var(--text-secondary)" }}>
          <span className="agent-spinner" aria-hidden />
          {statusText(turn.events)}
        </div>
      )}

      {turn.done && (
        <div className="agent-meta">
          <span>{turn.done.model}</span>
          <span>
            {turn.done.iterations} step{turn.done.iterations === 1 ? "" : "s"}
          </span>
          <span>
            {compact(turn.done.usage.promptTokens + turn.done.usage.completionTokens)} tokens
          </span>
          <span>{usd(turn.done.usage.costUsd)}</span>
          <button type="button" className="agent-link ml-auto" onClick={copy}>
            {copied ? "Copied" : "Copy answer"}
          </button>
        </div>
      )}
    </div>
  );
}

function Step({ ev }: { ev: Event }) {
  switch (ev.type) {
    case "iteration":
      return (
        <div className="agent-step-iter">
          Step {ev.n} · {ev.model}
        </div>
      );
    case "assistant":
      return (
        <div className="agent-step-text">
          <Markdown>{ev.text}</Markdown>
        </div>
      );
    case "tool_call":
      return (
        <details className="agent-tool">
          <summary>
            <span className="agent-tool-badge">tool</span> {ev.name}
          </summary>
          <pre>{JSON.stringify(ev.args, null, 2)}</pre>
        </details>
      );
    case "tool_result":
      return (
        <details className="agent-tool">
          <summary style={{ color: ev.isError ? "var(--status-critical)" : "var(--status-good)" }}>
            {ev.isError ? "✕" : "✓"} {ev.name} {ev.isError ? "failed" : "result"}
            <span style={{ color: "var(--text-muted)" }}> · {compact(ev.result.length)} chars</span>
          </summary>
          <pre>{ev.result}</pre>
        </details>
      );
    case "model_switch":
      return (
        <div className="text-xs" style={{ color: "var(--status-warning)" }}>
          ⚠ switched {ev.from} → {ev.to} ({ev.reason})
        </div>
      );
    default:
      return null;
  }
}
