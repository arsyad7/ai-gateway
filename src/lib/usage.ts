import { prisma } from "@/lib/db";
import type { TokenUsage } from "@/lib/types";

export type Period = "daily" | "weekly" | "monthly" | "total";

/** Start of the current window for a period. "total" means since the beginning. */
export function periodStart(period: string, now = new Date()): Date {
  const d = new Date(now);
  switch (period) {
    case "daily":
      d.setHours(0, 0, 0, 0);
      return d;
    case "weekly": {
      d.setHours(0, 0, 0, 0);
      // Week starts Monday.
      const shift = (d.getDay() + 6) % 7;
      d.setDate(d.getDate() - shift);
      return d;
    }
    case "monthly":
      return new Date(d.getFullYear(), d.getMonth(), 1);
    case "total":
    default:
      return new Date(0);
  }
}

export function periodEnd(period: string, now = new Date()): Date {
  const start = periodStart(period, now);
  const d = new Date(start);
  switch (period) {
    case "daily":
      d.setDate(d.getDate() + 1);
      return d;
    case "weekly":
      d.setDate(d.getDate() + 7);
      return d;
    case "monthly":
      return new Date(d.getFullYear(), d.getMonth() + 1, 1);
    default:
      return new Date(8640000000000000);
  }
}

export type PricedModel = {
  inputPricePerMTok: number;
  outputPricePerMTok: number;
};

/**
 * USD cost of one call. Cache reads bill at ~0.1x the input rate and cache
 * writes at ~1.25x, matching Anthropic/OpenAI pricing; providers that report
 * no cache tokens are unaffected.
 */
export function computeCost(model: PricedModel, usage: TokenUsage): number {
  const cachedRead = usage.cachedReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  const freshInput = Math.max(0, usage.promptTokens - cachedRead - cacheWrite);
  const inRate = model.inputPricePerMTok / 1_000_000;
  const outRate = model.outputPricePerMTok / 1_000_000;
  return (
    freshInput * inRate +
    cachedRead * inRate * 0.1 +
    cacheWrite * inRate * 1.25 +
    usage.completionTokens * outRate
  );
}

export type Spend = { tokens: number; usd: number; requests: number };

const ZERO: Spend = { tokens: 0, usd: 0, requests: 0 };

/**
 * Spend per model for the current window of each model's own period. Models
 * with different periods are queried in separate groups, so a daily-capped
 * model is never measured against a monthly window.
 */
export async function getModelSpend(
  models: { id: string; period: string }[],
  now = new Date(),
): Promise<Map<string, Spend>> {
  const byPeriod = new Map<string, string[]>();
  for (const m of models) {
    const list = byPeriod.get(m.period) ?? [];
    list.push(m.id);
    byPeriod.set(m.period, list);
  }

  const result = new Map<string, Spend>();
  for (const m of models) result.set(m.id, { ...ZERO });

  await Promise.all(
    [...byPeriod.entries()].map(async ([period, ids]) => {
      const rows = await prisma.usageLog.groupBy({
        by: ["modelId"],
        where: {
          modelId: { in: ids },
          status: "ok",
          createdAt: { gte: periodStart(period, now) },
        },
        _sum: { totalTokens: true, costUsd: true },
        _count: { _all: true },
      });
      for (const r of rows) {
        if (!r.modelId) continue;
        result.set(r.modelId, {
          tokens: r._sum.totalTokens ?? 0,
          usd: r._sum.costUsd ?? 0,
          requests: r._count._all,
        });
      }
    }),
  );

  return result;
}

export async function getKeySpend(
  apiKeyId: string,
  period: string,
  now = new Date(),
): Promise<Spend> {
  const agg = await prisma.usageLog.aggregate({
    where: {
      apiKeyId,
      status: "ok",
      createdAt: { gte: periodStart(period, now) },
    },
    _sum: { totalTokens: true, costUsd: true },
    _count: { _all: true },
  });
  return {
    tokens: agg._sum.totalTokens ?? 0,
    usd: agg._sum.costUsd ?? 0,
    requests: agg._count._all,
  };
}

export type LimitStatus = {
  /** 0..1 of the tighter of the two limits; 0 when nothing is capped. */
  used: number;
  /** Remaining headroom 0..1; 1 when uncapped. */
  remaining: number;
  exhausted: boolean;
  warning: boolean;
  tokenPct: number | null;
  usdPct: number | null;
};

export function limitStatus(
  limits: {
    limitTokens?: number | null;
    limitUsd?: number | null;
    alertThreshold?: number;
  },
  spend: Spend,
): LimitStatus {
  const tokenPct =
    limits.limitTokens && limits.limitTokens > 0
      ? spend.tokens / limits.limitTokens
      : null;
  const usdPct =
    limits.limitUsd && limits.limitUsd > 0 ? spend.usd / limits.limitUsd : null;

  const pcts = [tokenPct, usdPct].filter((p): p is number => p !== null);
  // The tightest limit governs.
  const used = pcts.length ? Math.max(...pcts) : 0;
  const threshold = limits.alertThreshold ?? 0.8;

  return {
    used,
    remaining: pcts.length ? Math.max(0, 1 - used) : 1,
    exhausted: pcts.length > 0 && used >= 1,
    warning: pcts.length > 0 && used >= threshold && used < 1,
    tokenPct,
    usdPct,
  };
}
