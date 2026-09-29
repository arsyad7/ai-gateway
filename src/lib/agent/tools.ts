import type { ToolSpec } from "@/lib/agent/types";

/** Built-in tools the server-side agent may call. */

const MATH_NAMES =
  /\b(sqrt|cbrt|sin|cos|tan|asin|acos|atan|log2|log10|log|exp|abs|pow|min|max|round|floor|ceil|sign|hypot|PI|E)\b/g;

function calculator(args: Record<string, unknown>): string {
  const expr = String(args.expression ?? "").trim();
  if (!expr) throw new Error("expression is required");
  if (expr.length > 300) throw new Error("expression too long");

  // Whitelist: after removing known function names, only plain math chars
  // may remain. This keeps `new Function` from ever seeing identifiers.
  const stripped = expr.replace(MATH_NAMES, "");
  if (!/^[0-9+\-*/().,%\s^eE]*$/.test(stripped)) {
    throw new Error(
      "expression may only contain numbers, + - * / ( ) . , % ^ and math functions like sqrt, log, pow, min, max, round, PI",
    );
  }

  const js = expr
    .replace(/\^/g, "**")
    .replace(MATH_NAMES, (m) => `Math.${m}`);
  const value = new Function("Math", `"use strict"; return (${js});`)(Math);
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("expression did not evaluate to a finite number");
  }
  return String(value);
}

const BLOCKED_HOST =
  /^(localhost|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\]|::1$)/i;

const MAX_FETCH_CHARS = 60_000;

/**
 * GET a public URL. Basic SSRF guard: only http(s), block obvious private
 * hosts. (Redirect targets and DNS-level tricks are not re-validated — do not
 * run this on a machine whose internal network must stay unreachable.)
 */
async function httpFetch(args: Record<string, unknown>): Promise<string> {
  const raw = String(args.url ?? "");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`invalid URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("only http/https URLs are allowed");
  }
  if (BLOCKED_HOST.test(url.hostname)) {
    throw new Error("requests to private/internal hosts are not allowed");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "user-agent": "aicad-agent/1.0", accept: "*/*" },
    });
    const type = res.headers.get("content-type") ?? "unknown";
    let body = await res.text();
    if (body.length > MAX_FETCH_CHARS) {
      body = body.slice(0, MAX_FETCH_CHARS) + "\n…[truncated]";
    }
    return `HTTP ${res.status} (${type})\n${body}`;
  } catch (err) {
    if ((err as Error).name === "AbortError") throw new Error("fetch timed out after 15s");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export const AGENT_TOOLS: ToolSpec[] = [
  {
    name: "calculator",
    description:
      "Evaluate a mathematical expression exactly. Supports + - * / % ^ ( ), and sqrt, log, log10, exp, abs, pow, min, max, round, floor, ceil, PI, E. Use this for any arithmetic instead of computing in your head.",
    parameters: {
      type: "object",
      properties: {
        expression: {
          type: "string",
          description: "The expression to evaluate, e.g. '0.5 * 67000 * 16500'",
        },
      },
      required: ["expression"],
    },
  },
  {
    name: "http_fetch",
    description:
      "HTTP GET a public URL and return the response body (truncated to ~60k chars). Use it to fetch web pages or call public JSON APIs. Only GET is supported.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute http(s) URL to fetch" },
      },
      required: ["url"],
    },
  },
];

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
): Promise<{ result: string; isError: boolean }> {
  try {
    switch (name) {
      case "calculator":
        return { result: calculator(args), isError: false };
      case "http_fetch":
        return { result: await httpFetch(args), isError: false };
      default:
        return { result: `unknown tool: ${name}`, isError: true };
    }
  } catch (err) {
    return { result: `error: ${(err as Error).message}`, isError: true };
  }
}
