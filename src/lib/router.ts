import type { ApiKey, Model, Provider } from "@prisma/client";
import { prisma } from "@/lib/db";
import { GatewayError } from "@/lib/types";
import {
  getKeySpend,
  getModelSpend,
  limitStatus,
  type LimitStatus,
  type Spend,
} from "@/lib/usage";

export type ModelWithProvider = Model & { provider: Provider };

export type Candidate = {
  model: ModelWithProvider;
  spend: Spend;
  status: LimitStatus;
};

export type RouteResult = {
  candidates: Candidate[];
  /** explicit | auto | fallback (fallback is set later, by the caller). */
  reason: "explicit" | "auto";
};

function keyAllows(key: ApiKey, alias: string): boolean {
  const allowed = key.allowedModels
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return allowed.length === 0 || allowed.includes(alias);
}

/**
 * Cost score for auto-routing: expected $ per 1M tokens with a nominal
 * 3:1 input:output ratio. Free/unpriced models score 0 and win.
 */
function costScore(m: Model): number {
  return m.inputPricePerMTok * 0.75 + m.outputPricePerMTok * 0.25;
}

/**
 * Auto-selection order:
 *   1. models still under all their limits, by (cost, remaining budget desc, priority)
 * Exhausted models are excluded entirely — the whole point of the budget.
 */
function rankAuto(candidates: Candidate[]): Candidate[] {
  return candidates
    .filter((c) => !c.status.exhausted)
    .sort((a, b) => {
      const cost = costScore(a.model) - costScore(b.model);
      if (Math.abs(cost) > 1e-9) return cost;
      // More remaining budget first, so traffic drains evenly near limits.
      const rem = b.status.remaining - a.status.remaining;
      if (Math.abs(rem) > 1e-9) return rem;
      return a.model.priority - b.model.priority;
    });
}

/**
 * Resolves the requested model name to an ordered candidate list.
 *
 *   "auto"          -> cheapest model with budget headroom, rest as fallbacks
 *   "auto:tag"      -> same, restricted to models carrying that tag
 *   "<alias>"       -> that model only (explicit choice is never silently
 *                      rerouted; if it's over budget the request fails fast)
 */
export async function route(
  requestedModel: string | undefined,
  apiKey: ApiKey | null,
): Promise<RouteResult> {
  const requested = (requestedModel ?? "auto").trim();
  const isAuto = requested === "auto" || requested.startsWith("auto:");
  const tag = requested.startsWith("auto:") ? requested.slice(5) : null;

  const models = await prisma.model.findMany({
    where: { enabled: true, provider: { enabled: true } },
    include: { provider: true },
  });
  if (models.length === 0) {
    throw new GatewayError(
      "No models configured. Add a provider and model in the dashboard.",
      503,
      "no_models",
    );
  }

  // Per-key budget applies to every request regardless of target model.
  if (apiKey && (apiKey.limitTokens || apiKey.limitUsd)) {
    const keySpend = await getKeySpend(apiKey.id, apiKey.period);
    const ks = limitStatus(apiKey, keySpend);
    if (ks.exhausted) {
      throw new GatewayError(
        `API key '${apiKey.name}' has exhausted its ${apiKey.period} budget.`,
        429,
        "key_budget_exhausted",
      );
    }
  }

  const spendMap = await getModelSpend(models);
  const toCandidate = (m: ModelWithProvider): Candidate => {
    const spend = spendMap.get(m.id) ?? { tokens: 0, usd: 0, requests: 0 };
    return { model: m, spend, status: limitStatus(m, spend) };
  };

  if (!isAuto) {
    const model = models.find((m) => m.alias === requested);
    if (!model) {
      throw new GatewayError(
        `Unknown model '${requested}'. Use an alias from /v1/models, or 'auto'.`,
        404,
        "model_not_found",
      );
    }
    if (apiKey && !keyAllows(apiKey, model.alias)) {
      throw new GatewayError(
        `This API key is not allowed to use '${model.alias}'.`,
        403,
        "model_not_allowed",
      );
    }
    const candidate = toCandidate(model);
    if (candidate.status.exhausted) {
      throw new GatewayError(
        `Model '${model.alias}' has exhausted its ${model.period} credit limit. ` +
          `Raise the limit in the dashboard or use 'auto' to route elsewhere.`,
        429,
        "model_budget_exhausted",
      );
    }
    return { candidates: [candidate], reason: "explicit" };
  }

  let pool = apiKey ? models.filter((m) => keyAllows(apiKey, m.alias)) : models;
  if (tag) {
    pool = pool.filter((m) =>
      m.tags
        .split(",")
        .map((t) => t.trim())
        .includes(tag),
    );
    if (pool.length === 0) {
      throw new GatewayError(
        `No models tagged '${tag}'.`,
        404,
        "no_models_for_tag",
      );
    }
  }

  const ranked = rankAuto(pool.map(toCandidate));
  if (ranked.length === 0) {
    throw new GatewayError(
      "All eligible models have exhausted their credit limits.",
      429,
      "all_budgets_exhausted",
    );
  }
  return { candidates: ranked, reason: "auto" };
}
