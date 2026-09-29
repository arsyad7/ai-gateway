import { prisma } from "@/lib/db";
import { authenticateGatewayKey } from "@/lib/auth";
import { errorResponse } from "@/lib/gateway";

export const runtime = "nodejs";

/** OpenAI-compatible model listing; ids are gateway aliases plus "auto". */
export async function GET(request: Request): Promise<Response> {
  try {
    await authenticateGatewayKey(request);
    const models = await prisma.model.findMany({
      where: { enabled: true, provider: { enabled: true } },
      include: { provider: { select: { kind: true } } },
      orderBy: { alias: "asc" },
    });
    return Response.json({
      object: "list",
      data: [
        { id: "auto", object: "model", owned_by: "gateway" },
        ...models.map((m) => ({
          id: m.alias,
          object: "model",
          owned_by: m.provider.kind,
        })),
      ],
    });
  } catch (err) {
    return errorResponse(err);
  }
}
