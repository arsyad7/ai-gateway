import { prisma } from "@/lib/db";
import { adminRoute, badRequest, optionalNumber, validPeriod } from "@/lib/admin";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export const PATCH = adminRoute(async (request: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const body = await request.json();
  const data: Record<string, unknown> = {};

  if (typeof body.alias === "string" && body.alias) data.alias = body.alias.trim();
  if (typeof body.upstreamModel === "string" && body.upstreamModel)
    data.upstreamModel = body.upstreamModel.trim();
  if (body.displayName !== undefined) data.displayName = body.displayName || null;
  if (typeof body.enabled === "boolean") data.enabled = body.enabled;
  if (typeof body.reasoning === "boolean") data.reasoning = body.reasoning;
  if (typeof body.tags === "string") data.tags = body.tags;
  for (const field of [
    "inputPricePerMTok",
    "outputPricePerMTok",
    "contextWindow",
    "maxOutputTokens",
    "priority",
    "limitTokens",
    "limitUsd",
    "alertThreshold",
  ] as const) {
    if (body[field] !== undefined) data[field] = optionalNumber(body[field], field);
  }
  if (body.period !== undefined) data.period = validPeriod(body.period);
  if (Object.keys(data).length === 0) badRequest("nothing to update");

  await prisma.model.update({ where: { id }, data });
  return Response.json({ ok: true });
});

export const DELETE = adminRoute(async (_request: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  await prisma.model.delete({ where: { id } });
  return Response.json({ ok: true });
});
