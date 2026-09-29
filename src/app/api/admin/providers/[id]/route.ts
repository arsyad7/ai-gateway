import { prisma } from "@/lib/db";
import { adminRoute, badRequest } from "@/lib/admin";
import { encryptSecret } from "@/lib/crypto";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export const PATCH = adminRoute(async (request: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const body = await request.json();
  const data: Record<string, unknown> = {};
  if (typeof body.name === "string" && body.name) data.name = body.name;
  if (typeof body.enabled === "boolean") data.enabled = body.enabled;
  if (body.baseUrl !== undefined) data.baseUrl = body.baseUrl || null;
  if (typeof body.apiKey === "string" && body.apiKey)
    data.apiKeyEnc = encryptSecret(body.apiKey);
  if (Object.keys(data).length === 0) badRequest("nothing to update");

  await prisma.provider.update({ where: { id }, data });
  return Response.json({ ok: true });
});

export const DELETE = adminRoute(async (_request: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  await prisma.provider.delete({ where: { id } });
  return Response.json({ ok: true });
});
