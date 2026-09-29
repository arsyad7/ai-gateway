import Anthropic from "@anthropic-ai/sdk";
import type {
  AgentMsg,
  AgentStep,
  ToolCall,
  ToolSpec,
} from "@/lib/agent/types";
import type { ProviderConfig, UpstreamModel } from "@/lib/types";
import { cliComplete, cliImageNote, writeImageFiles } from "@/lib/providers/claudeCli";
import { codexComplete } from "@/lib/providers/codexCli";
import {
  networkError,
  readErrorBody,
  upstreamError,
} from "@/lib/providers/errors";

/**
 * One non-streaming LLM call with tool definitions, per provider kind.
 * The loop in loop.ts drives these until the model stops calling tools.
 */
export async function agentCall(
  kind: string,
  cfg: ProviderConfig,
  model: UpstreamModel,
  system: string,
  msgs: AgentMsg[],
  tools: ToolSpec[],
  maxTokens: number,
): Promise<AgentStep> {
  switch (kind) {
    case "anthropic":
      return anthropicCall(cfg, model, system, msgs, tools, maxTokens);
    case "google":
      return googleCall(cfg, model, system, msgs, tools, maxTokens);
    case "claude_cli":
      return claudeCliCall(cfg, model, system, msgs, tools);
    case "codex_cli":
      return codexCliCall(cfg, model, system, msgs, tools);
    default:
      // openai and any openai_compatible server
      return openaiCall(kind, cfg, model, system, msgs, tools, maxTokens);
  }
}

/** Flattens a transcript into plain text for cross-provider model switches. */
export function flattenTranscript(msgs: AgentMsg[]): string {
  return msgs
    .map((m) => {
      if (m.role === "user") {
        const n = m.images?.length ?? 0;
        return `[user] ${m.content}${n ? ` [${n} image${n === 1 ? "" : "s"} attached]` : ""}`;
      }
      if (m.role === "assistant") {
        const calls = m.toolCalls
          .map((c) => `\n  called ${c.name}(${JSON.stringify(c.args)})`)
          .join("");
        return `[assistant] ${m.content}${calls}`;
      }
      return `[tool ${m.name}] ${m.content}`;
    })
    .join("\n");
}

// ---------------------------------------------------------------- anthropic

function anthropicMessages(msgs: AgentMsg[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  for (const m of msgs) {
    if (m.role === "user") {
      out.push({
        role: "user",
        content: m.images?.length
          ? [
              { type: "text", text: m.content },
              ...m.images.map(
                (img): Anthropic.ImageBlockParam => ({
                  type: "image",
                  source: { type: "base64", media_type: img.mediaType as "image/png", data: img.data },
                }),
              ),
            ]
          : m.content,
      });
    } else if (m.role === "assistant") {
      // Replay the provider's own blocks verbatim when we have them (keeps
      // thinking blocks intact, which Anthropic requires during tool use).
      if (m.raw && m.rawKind === "anthropic") {
        out.push({ role: "assistant", content: m.raw as Anthropic.ContentBlockParam[] });
      } else {
        const blocks: Anthropic.ContentBlockParam[] = [];
        if (m.content) blocks.push({ type: "text", text: m.content });
        for (const c of m.toolCalls) {
          blocks.push({ type: "tool_use", id: c.id, name: c.name, input: c.args });
        }
        out.push({ role: "assistant", content: blocks });
      }
    } else {
      // Consecutive tool results must share one user message.
      const block: Anthropic.ToolResultBlockParam = {
        type: "tool_result",
        tool_use_id: m.toolCallId,
        content: m.content,
      };
      const last = out[out.length - 1];
      if (last?.role === "user" && Array.isArray(last.content)) {
        (last.content as Anthropic.ContentBlockParam[]).push(block);
      } else {
        out.push({ role: "user", content: [block] });
      }
    }
  }
  return out;
}

async function anthropicCall(
  cfg: ProviderConfig,
  model: UpstreamModel,
  system: string,
  msgs: AgentMsg[],
  tools: ToolSpec[],
  maxTokens: number,
): Promise<AgentStep> {
  const client = new Anthropic({
    apiKey: cfg.apiKey,
    ...(cfg.baseUrl ? { baseURL: cfg.baseUrl } : {}),
  });
  try {
    const res = await client.messages.create({
      model: model.upstreamModel,
      max_tokens: maxTokens,
      system,
      messages: anthropicMessages(msgs),
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters as Anthropic.Tool.InputSchema,
      })),
    });
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const toolCalls: ToolCall[] = res.content
      .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
      .map((b) => ({
        id: b.id,
        name: b.name,
        args: (b.input ?? {}) as Record<string, unknown>,
      }));
    const cached = res.usage.cache_read_input_tokens ?? 0;
    const cacheWrite = res.usage.cache_creation_input_tokens ?? 0;
    return {
      text,
      toolCalls,
      finish: res.stop_reason ?? "end_turn",
      usage: {
        promptTokens: (res.usage.input_tokens ?? 0) + cached + cacheWrite,
        completionTokens: res.usage.output_tokens ?? 0,
        cachedReadTokens: cached,
        cacheWriteTokens: cacheWrite,
      },
      raw: res.content.map((b) => ({ ...b })),
    };
  } catch (err) {
    if (err instanceof Anthropic.APIError) {
      throw upstreamError("anthropic", err.status ?? 502, err.message);
    }
    throw networkError("anthropic", err);
  }
}

// ------------------------------------------------- openai / compatible

function openaiMessages(system: string, msgs: AgentMsg[]): unknown[] {
  const out: unknown[] = [{ role: "system", content: system }];
  for (const m of msgs) {
    if (m.role === "user") {
      out.push({
        role: "user",
        content: m.images?.length
          ? [
              { type: "text", text: m.content },
              ...m.images.map((img) => ({
                type: "image_url",
                image_url: { url: `data:${img.mediaType};base64,${img.data}` },
              })),
            ]
          : m.content,
      });
    } else if (m.role === "assistant") {
      out.push({
        role: "assistant",
        content: m.content || null,
        ...(m.toolCalls.length
          ? {
              tool_calls: m.toolCalls.map((c) => ({
                id: c.id,
                type: "function",
                function: { name: c.name, arguments: JSON.stringify(c.args) },
              })),
            }
          : {}),
      });
    } else {
      out.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content });
    }
  }
  return out;
}

async function openaiCall(
  kind: string,
  cfg: ProviderConfig,
  model: UpstreamModel,
  system: string,
  msgs: AgentMsg[],
  tools: ToolSpec[],
  maxTokens: number,
): Promise<AgentStep> {
  const base = (cfg.baseUrl || "https://api.openai.com/v1").replace(/\/$/, "");
  let res: Response;
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: model.upstreamModel,
        max_completion_tokens: maxTokens,
        messages: openaiMessages(system, msgs),
        tools: tools.map((t) => ({
          type: "function",
          function: {
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          },
        })),
      }),
    });
  } catch (err) {
    throw networkError(kind, err);
  }
  if (!res.ok) throw upstreamError(kind, res.status, await readErrorBody(res));

  const json = await res.json();
  const message = json.choices?.[0]?.message ?? {};
  const toolCalls: ToolCall[] = (message.tool_calls ?? []).map(
    (c: { id?: string; function?: { name?: string; arguments?: string } }, i: number) => {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(c.function?.arguments ?? "{}");
      } catch {
        args = { _raw: c.function?.arguments };
      }
      return { id: c.id ?? `call_${i}`, name: c.function?.name ?? "", args };
    },
  );
  return {
    text: message.content ?? "",
    toolCalls,
    finish: json.choices?.[0]?.finish_reason ?? "stop",
    usage: {
      promptTokens: json.usage?.prompt_tokens ?? 0,
      completionTokens: json.usage?.completion_tokens ?? 0,
      cachedReadTokens: json.usage?.prompt_tokens_details?.cached_tokens ?? 0,
    },
  };
}

// ---------------------------------------------------------------- google

function googleContents(msgs: AgentMsg[]): unknown[] {
  const out: { role: string; parts: unknown[] }[] = [];
  for (const m of msgs) {
    if (m.role === "user") {
      out.push({
        role: "user",
        parts: [
          { text: m.content },
          ...(m.images ?? []).map((img) => ({
            inlineData: { mimeType: img.mediaType, data: img.data },
          })),
        ],
      });
    } else if (m.role === "assistant") {
      const parts: unknown[] = [];
      if (m.content) parts.push({ text: m.content });
      for (const c of m.toolCalls) {
        parts.push({ functionCall: { name: c.name, args: c.args } });
      }
      out.push({ role: "model", parts });
    } else {
      const part = {
        functionResponse: { name: m.name, response: { result: m.content } },
      };
      const last = out[out.length - 1];
      if (last?.role === "user" && (last.parts[0] as { functionResponse?: unknown })?.functionResponse) {
        last.parts.push(part);
      } else {
        out.push({ role: "user", parts: [part] });
      }
    }
  }
  return out;
}

async function googleCall(
  cfg: ProviderConfig,
  model: UpstreamModel,
  system: string,
  msgs: AgentMsg[],
  tools: ToolSpec[],
  maxTokens: number,
): Promise<AgentStep> {
  const base = (cfg.baseUrl || "https://generativelanguage.googleapis.com/v1beta").replace(/\/$/, "");
  let res: Response;
  try {
    res = await fetch(
      `${base}/models/${model.upstreamModel}:generateContent`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": cfg.apiKey,
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: googleContents(msgs),
          generationConfig: { maxOutputTokens: maxTokens },
          tools: [
            {
              functionDeclarations: tools.map((t) => ({
                name: t.name,
                description: t.description,
                parameters: t.parameters,
              })),
            },
          ],
        }),
      },
    );
  } catch (err) {
    throw networkError("google", err);
  }
  if (!res.ok) throw upstreamError("google", res.status, await readErrorBody(res));

  const json = await res.json();
  const parts: { text?: string; thought?: boolean; functionCall?: { name: string; args?: Record<string, unknown> } }[] =
    json?.candidates?.[0]?.content?.parts ?? [];
  const text = parts
    .filter((p) => typeof p.text === "string" && !p.thought)
    .map((p) => p.text)
    .join("");
  const toolCalls: ToolCall[] = parts
    .filter((p) => p.functionCall)
    .map((p, i) => ({
      id: `gcall_${Date.now()}_${i}`,
      name: p.functionCall!.name,
      args: p.functionCall!.args ?? {},
    }));
  const u = json?.usageMetadata ?? {};
  return {
    text,
    toolCalls,
    finish: json?.candidates?.[0]?.finishReason?.toLowerCase() ?? "stop",
    usage: {
      promptTokens: u.promptTokenCount ?? 0,
      completionTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
      cachedReadTokens: u.cachedContentTokenCount ?? 0,
    },
  };
}

// ---------------------------------------------------------------- claude_cli

/**
 * `claude -p` has no custom-tool interface, so tool calling is done in the
 * prompt: the model writes <tool_call>{json}</tool_call> blocks and we parse
 * them. The CLI's own tools are disabled so only the gateway's tools exist.
 */
const CLI_TOOL_CALL_RE = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;

/** How attached images reach the CLI: a Read-tool path note, or attached natively. */
type ImageStyle = "read_tool" | "attached";

function cliAgentPrompt(
  system: string,
  msgs: AgentMsg[],
  tools: ToolSpec[],
  imageStyle: ImageStyle = "read_tool",
  /** false when the system prompt reaches the model another way (CLI flag). */
  inlineSystem = true,
): string {
  const hasImages = msgs.some((m) => m.role === "user" && m.images?.length);
  const toolDocs = tools
    .map(
      (t) =>
        `- ${t.name}: ${t.description}\n  arguments (JSON schema): ${JSON.stringify(t.parameters)}`,
    )
    .join("\n");
  const transcript = msgs
    .map((m) => {
      if (m.role === "user") {
        const n = m.images?.length ?? 0;
        const note = !n
          ? ""
          : imageStyle === "read_tool"
            ? `\n\n${cliImageNote(m.images!)}`
            : `\n[${n} image${n === 1 ? "" : "s"} attached to this prompt]`;
        return `[user]\n${m.content}${note}`;
      }
      if (m.role === "assistant") {
        const calls = m.toolCalls
          .map((c) => `\n<tool_call>${JSON.stringify({ name: c.name, args: c.args })}</tool_call>`)
          .join("");
        return `[assistant]\n${m.content}${calls}`;
      }
      return `[tool_result ${m.name}]\n${m.content}`;
    })
    .join("\n\n");

  const head = inlineSystem ? `<system instructions>\n${system}\n</system instructions>\n\n` : "";
  return `${head}${hasImages && imageStyle === "read_tool" ? "Your only built-in tool is Read, for viewing the attached image files named below. " : "Do not run commands or read files in this session. "}The only tools to use are the ones below, run for you by the gateway:
${toolDocs}

To call a tool, write a block in exactly this form (several blocks are allowed), then stop and wait — never invent a tool result:
<tool_call>{"name": "<tool name>", "args": { ... }}</tool_call>

When you need no more tools, reply with the final answer and no <tool_call> block.

--- conversation so far ---
${transcript}
--- end ---

Write the assistant's next turn only.`;
}

async function claudeCliCall(
  cfg: ProviderConfig,
  model: UpstreamModel,
  system: string,
  msgs: AgentMsg[],
  tools: ToolSpec[],
): Promise<AgentStep> {
  const images = msgs.flatMap((m) => (m.role === "user" ? (m.images ?? []) : []));
  await writeImageFiles(images);
  // The system prompt goes through the CLI's --system-prompt-file so it
  // replaces Claude Code's own identity instead of competing with it.
  const res = await cliComplete(
    cfg,
    model,
    cliAgentPrompt(system, msgs, tools, "read_tool", false),
    undefined,
    undefined,
    images.length > 0,
    system,
  );

  const known = new Set(tools.map((t) => t.name));
  const toolCalls: ToolCall[] = [];
  const text = res.text
    .replace(CLI_TOOL_CALL_RE, (block, body: string) => {
      try {
        const parsed = JSON.parse(body) as { name?: string; args?: Record<string, unknown> };
        if (parsed.name && known.has(parsed.name)) {
          toolCalls.push({
            id: `cli_${Date.now()}_${toolCalls.length}`,
            name: parsed.name,
            args: parsed.args ?? {},
          });
          return "";
        }
      } catch {
        /* malformed block: leave it in the text */
      }
      return block;
    })
    .trim();

  return {
    text,
    toolCalls,
    finish: toolCalls.length ? "tool_use" : res.finishReason,
    usage: res.usage,
  };
}

/** Pulls <tool_call> blocks out of a CLI reply; shared by both CLI kinds. */
function parseCliToolCalls(text: string, tools: ToolSpec[]): { text: string; toolCalls: ToolCall[] } {
  const known = new Set(tools.map((t) => t.name));
  const toolCalls: ToolCall[] = [];
  const cleaned = text
    .replace(CLI_TOOL_CALL_RE, (block, body: string) => {
      try {
        const parsed = JSON.parse(body) as { name?: string; args?: Record<string, unknown> };
        if (parsed.name && known.has(parsed.name)) {
          toolCalls.push({
            id: `cli_${Date.now()}_${toolCalls.length}`,
            name: parsed.name,
            args: parsed.args ?? {},
          });
          return "";
        }
      } catch {
        /* malformed block: leave it in the text */
      }
      return block;
    })
    .trim();
  return { text: cleaned, toolCalls };
}

async function codexCliCall(
  cfg: ProviderConfig,
  model: UpstreamModel,
  system: string,
  msgs: AgentMsg[],
  tools: ToolSpec[],
): Promise<AgentStep> {
  const images = msgs.flatMap((m) => (m.role === "user" ? (m.images ?? []) : []));
  const res = await codexComplete(cfg, model, {
    messages: [
      {
        role: "user",
        content: images.length
          ? [{ type: "text", text: cliAgentPrompt(system, msgs, tools, "attached") }, ...images]
          : cliAgentPrompt(system, msgs, tools, "attached"),
      },
    ],
    stream: false,
  });
  const { text, toolCalls } = parseCliToolCalls(res.text, tools);
  return {
    text,
    toolCalls,
    finish: toolCalls.length ? "tool_use" : res.finishReason,
    usage: res.usage,
  };
}
