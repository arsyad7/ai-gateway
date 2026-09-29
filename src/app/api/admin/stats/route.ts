import { prisma } from "@/lib/db";
import { adminRoute } from "@/lib/admin";

export const runtime = "nodejs";

/** Local-time YYYY-MM-DD, so buckets and logs agree regardless of timezone. */
function localDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Dashboard data: totals, 14-day per-model daily series, recent requests. */
export const GET = adminRoute(async () => {
  const since = new Date();
  since.setDate(since.getDate() - 13);
  since.setHours(0, 0, 0, 0);

  const [logs, recent, totals] = await Promise.all([
    prisma.usageLog.findMany({
      where: { createdAt: { gte: since }, status: "ok" },
      select: {
        createdAt: true,
        modelAlias: true,
        totalTokens: true,
        costUsd: true,
      },
    }),
    prisma.usageLog.findMany({
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true,
        createdAt: true,
        modelAlias: true,
        providerKind: true,
        requestedModel: true,
        routedReason: true,
        promptTokens: true,
        completionTokens: true,
        totalTokens: true,
        costUsd: true,
        latencyMs: true,
        status: true,
        errorCode: true,
        stream: true,
      },
    }),
    prisma.usageLog.aggregate({
      where: { status: "ok" },
      _sum: { totalTokens: true, costUsd: true },
      _count: { _all: true },
    }),
  ]);

  // Bucket per (day, model) in local server time: tokens, cost, and requests.
  type Row = Record<string, number> & { date: string };
  const makeBuckets = () => {
    const m = new Map<string, Row>();
    for (let i = 0; i < 14; i++) {
      const d = new Date(since);
      d.setDate(d.getDate() + i);
      const key = localDateKey(d);
      m.set(key, { date: key } as Row);
    }
    return m;
  };
  const tokenBuckets = makeBuckets();
  const usdBuckets = makeBuckets();
  const requestBuckets = makeBuckets();
  const aliases = new Set<string>();

  for (const log of logs) {
    const key = localDateKey(new Date(log.createdAt));
    const tok = tokenBuckets.get(key);
    if (!tok) continue;
    aliases.add(log.modelAlias);
    tok[log.modelAlias] = (tok[log.modelAlias] ?? 0) + log.totalTokens;
    const cost = usdBuckets.get(key)!;
    cost[log.modelAlias] = (cost[log.modelAlias] ?? 0) + log.costUsd;
    const req = requestBuckets.get(key)!;
    req.requests = (req.requests ?? 0) + 1;
  }

  const errorCount = await prisma.usageLog.count({ where: { status: "error" } });

  return Response.json({
    totals: {
      requests: totals._count._all,
      tokens: totals._sum.totalTokens ?? 0,
      usd: totals._sum.costUsd ?? 0,
      errors: errorCount,
    },
    dailySeries: [...tokenBuckets.values()],
    usdSeries: [...usdBuckets.values()],
    requestSeries: [...requestBuckets.values()],
    seriesModels: [...aliases].sort(),
    recent,
  });
});
