import { prisma } from "@/lib/db";
import { adminRoute, badRequest, optionalNumber, validPeriod } from "@/lib/admin";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export const PATCH = adminRoute(async (request: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const body = await request.json();
  const data: Record<string, unknown> = {};
  if (typeof body.name === "string" && body.name) data.name = body.name;
  if (typeof body.enabled === "boolean") data.enabled = body.enabled;
  if (typeof body.allowedModels === "string") data.allowedModels = body.allowedModels;
  for (const field of ["limitTokens", "limitUsd"] as const) {
    if (body[field] !== undefined) data[field] = optionalNumber(body[field], field);
  }
  if (body.period !== undefined) data.period = validPeriod(body.period);
  if (Object.keys(data).length === 0) badRequest("nothing to update");

  await prisma.apiKey.update({ where: { id }, data });
  return Response.json({ ok: true });
});

export const DELETE = adminRoute(async (_request: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  await prisma.apiKey.delete({ where: { id } });
  return Response.json({ ok: true });
});
