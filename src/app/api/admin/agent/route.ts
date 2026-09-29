import { requireAdmin } from "@/lib/auth";
import { errorResponse, handleAgentRequest } from "@/lib/agent/handler";
import { GatewayError } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

/** Agent Playground backend: session-authed, no gateway key needed. */
export async function POST(request: Request): Promise<Response> {
  try {
    await requireAdmin();
    const body = await request.json().catch(() => {
      throw new GatewayError("Request body must be JSON", 400, "invalid_json");
    });
    return await handleAgentRequest(null, body);
  } catch (err) {
    return errorResponse(err);
  }
}
