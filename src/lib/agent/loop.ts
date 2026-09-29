import type { ApiKey } from "@prisma/client";
import { prisma } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import { route, type Candidate } from "@/lib/router";
import { computeCost, getModelSpend, limitStatus } from "@/lib/usage";
import { GatewayError, type TokenUsage } from "@/lib/types";
import { AGENT_TOOLS, executeTool } from "@/lib/agent/tools";
import { agentCall, flattenTranscript } from "@/lib/agent/providers";
import type { AgentEvent, AgentHistoryMsg, AgentMsg } from "@/lib/agent/types";
import type { ImagePart } from "@/lib/types";

const DEFAULT_SYSTEM = `You are AIcad, an autonomous agent running inside an AI gateway. Work toward the user's task step by step:
- Use the available tools whenever they help (fetching live data, exact arithmetic). Never guess numbers you can compute or fetch.
- After each tool result, decide the next step yourself and keep going without asking for permission.
- When the task is complete, give the final answer clearly and concisely, in the same language the task was written in.
- Format replies in Markdown: fenced code blocks with a language tag for code, commands and raw data; inline code for identifiers and URLs; bullet lists, short headings or a table when they make a longer answer easier to scan; bold for key figures. Keep short answers short.`;

export type AgentRunOptions = {
  /** null = dashboard playground (session-authed, no gateway key). */
  apiKey: ApiKey | null;
  model?: string;
  task: string;
  /** Prior turns (user/assistant text only) so the task can be a follow-up. */
  history?: AgentHistoryMsg[];
  /** Images attached to the task. */
  images?: ImagePart[];
  system?: string;
  maxIterations?: number;
  maxTokensPerCall?: number;
  emit: (event: AgentEvent) => void | Promise<void>;
};

export type AgentRunResult = {
  answer: string;
  iterations: number;
  model: string;
  usage: { promptTokens: number; completionTokens: number; costUsd: number };
};

async function logIteration(p: {
  apiKey: ApiKey | null;
  candidate: Candidate;
  requestedModel: string;
  usage: TokenUsage | null;
  latencyMs: number;
  ok: boolean;
  errorMsg?: string;
}): Promise<number> {
  const { model } = p.candidate;
  const cost = p.usage ? computeCost(model, p.usage) : 0;
  await prisma.usageLog
    .create({
      data: {
        apiKeyId: p.apiKey?.id ?? null,
        modelId: model.id,
        modelAlias: model.alias,
        providerKind: model.provider.kind,
        providerName: model.provider.name,
        requestedModel: p.requestedModel,
        routedReason: "agent",
        promptTokens: p.usage?.promptTokens ?? 0,
        completionTokens: p.usage?.completionTokens ?? 0,
        totalTokens:
          (p.usage?.promptTokens ?? 0) + (p.usage?.completionTokens ?? 0),
        costUsd: cost,
        latencyMs: p.latencyMs,
        status: p.ok ? "ok" : "error",
        errorMsg: p.errorMsg?.slice(0, 500) ?? null,
      },
    })
    .catch((e) => console.error("agent usage log failed:", e));
  return cost;
}

/** True when this candidate's budget for its period is used up right now. */
async function isExhausted(candidate: Candidate): Promise<boolean> {
  if (!candidate.model.limitTokens && !candidate.model.limitUsd) return false;
  const spend = await getModelSpend([candidate.model]);
  const s = spend.get(candidate.model.id);
  return s ? limitStatus(candidate.model, s).exhausted : false;
}

/**
 * The ReAct loop: call the model with tools, execute requested tools, feed
 * results back, repeat until the model answers or limits are hit. Budget is
 * re-checked before every iteration so a long run cannot blow through a cap.
 */
export async function runAgentLoop(
  opts: AgentRunOptions,
): Promise<AgentRunResult> {
  let requestedModel = (opts.model ?? "auto").trim();
  if (requestedModel === "auto" && opts.images?.length) {
    const visionModels = await prisma.model.count({
      where: { enabled: true, tags: { contains: "vision" } },
    });
    if (visionModels > 0) requestedModel = "auto:vision";
  }
  const maxIterations = Math.min(Math.max(opts.maxIterations ?? 8, 1), 25);
  const maxTokensPerCall = Math.min(opts.maxTokensPerCall ?? 8192, 32000);
  const system = opts.system?.trim() || DEFAULT_SYSTEM;
  const { emit } = opts;

  const { candidates, reason } = await route(requestedModel, opts.apiKey);
  const queue = [...candidates];
  let current = queue.shift()!;

  await emit({
    type: "start",
    model: current.model.alias,
    maxIterations,
  });

  let transcript: AgentMsg[] = [
    ...(opts.history ?? []).map<AgentMsg>((m) =>
      m.role === "user"
        ? { role: "user", content: m.content }
        : { role: "assistant", content: m.content, toolCalls: [] },
    ),
    { role: "user", content: opts.task, images: opts.images },
  ];
  const total = { promptTokens: 0, completionTokens: 0, costUsd: 0 };
  let lastText = "";

  const switchModel = async (why: string): Promise<boolean> => {
    // Explicit model choice is never rerouted; auto falls to the next model.
    if (reason === "explicit") return false;
    const from = current.model.alias;
    while (queue.length) {
      const next = queue.shift()!;
      if (await isExhausted(next)) continue;
      // Cross-provider raw blocks can't be replayed; flatten prior progress.
      if (next.model.provider.kind !== current.model.provider.kind) {
        transcript = [
          {
            role: "user",
            content: `${opts.task}\n\n--- progress so far (from a previous model) ---\n${flattenTranscript(transcript)}\n--- continue from here ---`,
            images: opts.images,
          },
        ];
      }
      current = next;
      await emit({ type: "model_switch", from, to: current.model.alias, reason: why });
      return true;
    }
    return false;
  };

  for (let iter = 1; iter <= maxIterations; iter++) {
    // Credit check before every LLM call.
    if (await isExhausted(current)) {
      const moved = await switchModel("credit limit exhausted");
      if (!moved) {
        throw new GatewayError(
          `Model '${current.model.alias}' exhausted its credit limit mid-run and no fallback is available.`,
          429,
          "model_budget_exhausted",
        );
      }
    }

    await emit({ type: "iteration", n: iter, model: current.model.alias });

    const cfg = {
      apiKey: decryptSecret(current.model.provider.apiKeyEnc),
      baseUrl: current.model.provider.baseUrl,
    };
    const upstream = {
      upstreamModel: current.model.upstreamModel,
      maxOutputTokens: current.model.maxOutputTokens,
      reasoning: current.model.reasoning,
    };

    const started = Date.now();
    let step;
    try {
      step = await agentCall(
        current.model.provider.kind,
        cfg,
        upstream,
        system,
        transcript,
        AGENT_TOOLS,
        maxTokensPerCall,
      );
    } catch (err) {
      const g =
        err instanceof GatewayError
          ? err
          : new GatewayError(String(err), 502, "upstream_error", true);
      await logIteration({
        apiKey: opts.apiKey,
        candidate: current,
        requestedModel,
        usage: null,
        latencyMs: Date.now() - started,
        ok: false,
        errorMsg: g.message,
      });
      if (g.retryable && (await switchModel(`upstream error: ${g.code}`))) {
        iter--; // retry this iteration on the new model
        continue;
      }
      throw g;
    }

    total.promptTokens += step.usage.promptTokens;
    total.completionTokens += step.usage.completionTokens;
    total.costUsd += await logIteration({
      apiKey: opts.apiKey,
      candidate: current,
      requestedModel,
      usage: step.usage,
      latencyMs: Date.now() - started,
      ok: true,
    });

    if (step.text) {
      lastText = step.text;
      await emit({ type: "assistant", text: step.text });
    }

    transcript.push({
      role: "assistant",
      content: step.text,
      toolCalls: step.toolCalls,
      raw: step.raw,
      rawKind: step.raw ? current.model.provider.kind : undefined,
    });

    // No tool calls -> the agent is done.
    if (step.toolCalls.length === 0) {
      const result = {
        answer: lastText,
        iterations: iter,
        model: current.model.alias,
        usage: { ...total },
      };
      await emit({ type: "done", ...result });
      return result;
    }

    // Execute every requested tool (in order; they may depend on rate limits).
    for (const call of step.toolCalls) {
      await emit({ type: "tool_call", id: call.id, name: call.name, args: call.args });
      const { result, isError } = await executeTool(call.name, call.args);
      await emit({
        type: "tool_result",
        id: call.id,
        name: call.name,
        result: result.length > 2000 ? result.slice(0, 2000) + "…[truncated in event]" : result,
        isError,
      });
      transcript.push({
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content: result,
      });
    }
  }

  // Iteration cap reached: return the best answer we have.
  const result = {
    answer:
      lastText ||
      "(iteration limit reached before the agent produced a final answer)",
    iterations: maxIterations,
    model: current.model.alias,
    usage: { ...total },
  };
  await emit({ type: "done", ...result });
  return result;
}
