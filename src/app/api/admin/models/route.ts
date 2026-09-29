import { prisma } from "@/lib/db";
import { adminRoute, badRequest, optionalNumber, validPeriod } from "@/lib/admin";
import { getModelSpend, limitStatus } from "@/lib/usage";

export const runtime = "nodejs";

/** Models with live spend + limit status — powers the monitoring dashboard. */
export const GET = adminRoute(async () => {
  const models = await prisma.model.findMany({
    include: { provider: { select: { id: true, name: true, kind: true, enabled: true } } },
    orderBy: { alias: "asc" },
  });
  const spend = await getModelSpend(models);

  return Response.json(
    models.map((m) => {
      const s = spend.get(m.id) ?? { tokens: 0, usd: 0, requests: 0 };
      const status = limitStatus(m, s);
      return {
        id: m.id,
        alias: m.alias,
        displayName: m.displayName,
        upstreamModel: m.upstreamModel,
        provider: m.provider,
        enabled: m.enabled,
        priority: m.priority,
        tags: m.tags,
        reasoning: m.reasoning,
        inputPricePerMTok: m.inputPricePerMTok,
        outputPricePerMTok: m.outputPricePerMTok,
        limitTokens: m.limitTokens,
        limitUsd: m.limitUsd,
        period: m.period,
        alertThreshold: m.alertThreshold,
        spend: s,
        limit: {
          used: status.used,
          remaining: status.remaining,
          exhausted: status.exhausted,
          warning: status.warning,
          tokenPct: status.tokenPct,
          usdPct: status.usdPct,
        },
      };
    }),
  );
});

export const POST = adminRoute(async (request: Request) => {
  const body = await request.json();
  const { providerId, alias, upstreamModel } = body ?? {};
  if (!providerId) badRequest("providerId is required");
  if (!alias || typeof alias !== "string") badRequest("alias is required");
  if (!upstreamModel || typeof upstreamModel !== "string")
    badRequest("upstreamModel is required");

  const model = await prisma.model.create({
    data: {
      providerId,
      alias: alias.trim(),
      upstreamModel: upstreamModel.trim(),
      displayName: body.displayName || null,
      inputPricePerMTok: optionalNumber(body.inputPricePerMTok, "inputPricePerMTok") ?? 0,
      outputPricePerMTok: optionalNumber(body.outputPricePerMTok, "outputPricePerMTok") ?? 0,
      contextWindow: optionalNumber(body.contextWindow, "contextWindow"),
      maxOutputTokens: optionalNumber(body.maxOutputTokens, "maxOutputTokens"),
      priority: optionalNumber(body.priority, "priority") ?? 100,
      tags: typeof body.tags === "string" ? body.tags : "",
      reasoning: body.reasoning === true,
      limitTokens: optionalNumber(body.limitTokens, "limitTokens"),
      limitUsd: optionalNumber(body.limitUsd, "limitUsd"),
      period: validPeriod(body.period),
      alertThreshold: optionalNumber(body.alertThreshold, "alertThreshold") ?? 0.8,
    },
  });
  return Response.json({ id: model.id }, { status: 201 });
});
