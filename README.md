# AIcad

One endpoint in front of many AI providers, with a dashboard for keys, models,
and **token/credit limit monitoring**.

**Author:** Arsyad

- **OpenAI-compatible API** — point any OpenAI SDK at `/api/v1` and it works.
- **Pick a model or let the gateway pick** — send `"model": "<alias>"` to use a
  specific model, `"model": "auto"` to let the gateway choose the cheapest model
  that still has credit budget left (with automatic fallback if an upstream
  fails), or `"model": "auto:<tag>"` to restrict auto-choice to a tag
  (e.g. `auto:cheap`, `auto:reasoning`).
- **Credit limits per model** — token and/or USD budgets per day/week/month.
  The dashboard shows live meters; exhausted models are excluded from auto
  routing and explicit requests to them return `429`.
- **Per-client gateway keys** — issue keys with their own budgets and model
  allowlists; provider API keys are stored encrypted (AES-256-GCM) and never
  leave the server.

Providers supported: **Anthropic (Claude)**, **OpenAI**, **Google Gemini**, and
any **OpenAI-compatible** server (OpenRouter, Groq, DeepSeek, Ollama, vLLM…).

## Setup

```bash
npm install
cp .env.example .env       # then edit .env  (a ready .env was generated for you)
npm run setup              # creates the SQLite db + seeds models for any provider keys in .env
npm run dev                # dashboard at http://localhost:3000
```

`.env` needs:

| Var | What |
|---|---|
| `DATABASE_URL` | `file:./dev.db` (SQLite) — switch to Postgres by changing this and `prisma/schema.prisma`'s provider |
| `ADMIN_PASSWORD` | dashboard login password |
| `SESSION_SECRET` | signs the dashboard session cookie (`openssl rand -hex 32`) |
| `ENCRYPTION_KEY` | encrypts provider API keys at rest (`openssl rand -hex 32`) — don't change it after storing keys |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GOOGLE_API_KEY` | optional; if set, `npm run db:seed` auto-creates those providers + common models |

## Using the gateway

1. In the dashboard: **Providers** → add a provider (its API key is encrypted).
2. **Models & Limits** → register models: alias, upstream model id, prices per
   MTok, and optional token/USD limit + period + warn threshold.
3. **API Keys** → create a gateway key (shown once).
4. Call it like OpenAI:

```bash
curl http://localhost:3000/api/v1/chat/completions \
  -H "Authorization: Bearer gw_live_..." \
  -H "Content-Type: application/json" \
  -d '{
    "model": "auto",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

Or with an SDK:

```ts
import OpenAI from "openai";
const client = new OpenAI({
  apiKey: "gw_live_...",
  baseURL: "http://localhost:3000/api/v1",
});
const res = await client.chat.completions.create({
  model: "auto",            // or "claude-opus-5", "auto:cheap", ...
  messages: [{ role: "user", content: "Hello!" }],
});
```

`GET /api/v1/models` lists the aliases the key can use.

## How auto-routing decides

1. Take all enabled models the key is allowed to use (optionally filtered by
   `auto:<tag>`).
2. Drop models whose token or USD budget for the current period is exhausted.
3. Sort by expected cost (per-MTok prices at a 3:1 input:output mix), then by
   most remaining budget, then by the model's priority number.
4. Try in order; if an upstream returns a retryable error (429/5xx/network),
   fall through to the next candidate. The usage log records whether a request
   was served `explicit`, `auto`, or `fallback`.

Explicit model requests are never rerouted — if that model is over budget you
get a `429` with code `model_budget_exhausted`.

## Monitoring

The **Overview** page auto-refreshes every 15s: totals, tokens/day by model
(stacked, last 14 days), per-model budget meters (warn at the configured
threshold, red when exhausted), and the recent request log with route reason,
token counts, cost, and latency. Costs are computed from each response's real
usage numbers (cache reads/writes priced at 0.1×/1.25× input rate where
providers report them).

## Notes

- Budget checks read the current period's usage at request time; a request
  already in flight when the limit is crossed still completes — limits are
  a monthly-bill guard, not a hard concurrency gate.
- Streaming responses count usage from the provider's final usage frame; the
  few OpenAI-compatible servers that omit it fall back to a character-based
  estimate (flagged `estimated` internally).
- `npm run build` runs `prisma generate` — stop the dev/prod server first on
  Windows, or the query-engine DLL is locked and generate fails with EPERM.

## Agent (server-side ReAct loop)

`POST /api/v1/agent` runs an autonomous agent loop inside the gateway: the
model thinks, calls built-in tools, reads the results, and repeats until it
answers (or `max_iterations` is hit). Works with every provider via native
function calling; `auto` routing and credit limits apply — the budget is
re-checked before every iteration, and each LLM call is logged with route
reason `agent`.

```bash
curl http://localhost:3000/api/v1/agent \
  -H "Authorization: Bearer gw_live_..." \
  -H "Content-Type: application/json" \
  -d '{
    "model": "auto",
    "task": "Fetch the BTC price from the CoinGecko API and compute 0.5 BTC in IDR at 16,500/USD",
    "max_iterations": 10,
    "stream": true
  }'
```

- `stream: true` → SSE events (`start`, `iteration`, `assistant`, `tool_call`,
  `tool_result`, `model_switch`, `done`, `error`); omit for a single JSON
  result `{answer, iterations, model, usage, events}`.
- Built-in tools: `http_fetch` (GET a public URL, 15s timeout, 60k chars max,
  private hosts blocked) and `calculator` (safe math eval). Add more in
  `src/lib/agent/tools.ts`.
- If a model exhausts its budget or fails mid-run under `auto`, the loop
  switches to the next cheapest model (cross-provider switches flatten the
  transcript so far into context).
- The dashboard's **Agent** page is a playground for the same loop with a live
  timeline.

## Claude CLI provider (subscription billing)

Provider kind `claude_cli` routes chat completions through the local
`claude -p` (Claude Code CLI) instead of the Anthropic API — usage bills to
the machine's **Claude subscription**, not an API key. Add a provider with
kind *Claude CLI* (no API key; the CLI's own login is used), then register
models whose upstream id is a CLI model name (`haiku`, `sonnet`, `opus`, or a
full model id). Set prices to 0 and use token limits for monitoring.

Notes:
- The CLI must be logged in (`claude` → login) on the machine running the
  gateway; each request spawns one CLI process (a few seconds of latency).
- Reported prompt tokens include Claude Code's own system prompt and cache
  traffic (~25k/call, mostly cache reads) — that is the real subscription
  usage, so token meters reflect it.
- In the `/v1/agent` loop the CLI has no custom-tool interface, so tool calls
  are prompt-based: the model writes `<tool_call>{json}</tool_call>` blocks the
  gateway parses, and the CLI's built-in tools are disabled (`--tools ""`).
  Less strict than native tool calling, and each iteration spawns a CLI process.
- A Claude subscription is for personal use — keep this for your own local
  gateway, don't resell it as a public API.
