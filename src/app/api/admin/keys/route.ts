import { prisma } from "@/lib/db";
import { adminRoute, badRequest, optionalNumber, validPeriod } from "@/lib/admin";
import { generateGatewayKey } from "@/lib/crypto";
import { getKeySpend, limitStatus } from "@/lib/usage";

export const runtime = "nodejs";

export const GET = adminRoute(async () => {
  const keys = await prisma.apiKey.findMany({ orderBy: { createdAt: "asc" } });
  const withSpend = await Promise.all(
    keys.map(async (k) => {
      const spend = await getKeySpend(k.id, k.period);
      const status = limitStatus(k, spend);
      return {
        id: k.id,
        name: k.name,
        keyPrefix: k.keyPrefix,
        enabled: k.enabled,
        limitTokens: k.limitTokens,
        limitUsd: k.limitUsd,
        period: k.period,
        allowedModels: k.allowedModels,
        createdAt: k.createdAt,
        lastUsedAt: k.lastUsedAt,
        spend,
        limit: {
          used: status.used,
          exhausted: status.exhausted,
          warning: status.warning,
        },
      };
    }),
  );
  return Response.json(withSpend);
});

export const POST = adminRoute(async (request: Request) => {
  const body = await request.json();
  if (!body?.name || typeof body.name !== "string") badRequest("name is required");

  const { raw, hash, prefix } = generateGatewayKey();
  const key = await prisma.apiKey.create({
    data: {
      name: body.name,
      keyHash: hash,
      keyPrefix: prefix,
      limitTokens: optionalNumber(body.limitTokens, "limitTokens"),
      limitUsd: optionalNumber(body.limitUsd, "limitUsd"),
      period: validPeriod(body.period),
      allowedModels: typeof body.allowedModels === "string" ? body.allowedModels : "",
    },
  });
  // The raw key is returned exactly once and never stored.
  return Response.json({ id: key.id, key: raw }, { status: 201 });
});
