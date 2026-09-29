import { prisma } from "@/lib/db";
import { adminRoute, badRequest } from "@/lib/admin";
import { encryptSecret, decryptSecret, maskSecret } from "@/lib/crypto";
import { CLI_KINDS, PROVIDER_KINDS } from "@/lib/providers";

export const runtime = "nodejs";

export const GET = adminRoute(async () => {
  const providers = await prisma.provider.findMany({
    orderBy: { createdAt: "asc" },
    include: { _count: { select: { models: true } } },
  });
  return Response.json(
    providers.map((p) => ({
      id: p.id,
      name: p.name,
      kind: p.kind,
      baseUrl: p.baseUrl,
      enabled: p.enabled,
      modelCount: p._count.models,
      apiKeyMasked: maskSecret(safeDecrypt(p.apiKeyEnc)),
      createdAt: p.createdAt,
    })),
  );
});

function safeDecrypt(enc: string): string {
  try {
    return decryptSecret(enc);
  } catch {
    return "????????????"; // ENCRYPTION_KEY changed since this was stored
  }
}

export const POST = adminRoute(async (request: Request) => {
  const body = await request.json();
  const { name, kind, apiKey, baseUrl } = body ?? {};
  if (!name || typeof name !== "string") badRequest("name is required");
  if (!PROVIDER_KINDS.includes(kind))
    badRequest(`kind must be one of: ${PROVIDER_KINDS.join(", ")}`);
  // CLI providers use the local CLI's own login, so no key is needed.
  if (!CLI_KINDS.includes(kind) && (!apiKey || typeof apiKey !== "string"))
    badRequest("apiKey is required");
  if (kind === "openai_compatible" && !baseUrl)
    badRequest("baseUrl is required for openai_compatible providers");

  const provider = await prisma.provider.create({
    data: {
      name,
      kind,
      baseUrl: baseUrl || null,
      apiKeyEnc: encryptSecret(apiKey || "local"),
    },
  });
  return Response.json({ id: provider.id }, { status: 201 });
});
