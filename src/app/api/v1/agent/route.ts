import { authenticateGatewayKey } from "@/lib/auth";
import { errorResponse, handleAgentRequest } from "@/lib/agent/handler";
import { GatewayError } from "@/lib/types";

export const runtime = "nodejs";
// Agent runs make several LLM calls back to back.
export const maxDuration = 300;

export async function POST(request: Request): Promise<Response> {
  try {
    const apiKey = await authenticateGatewayKey(request);
    const body = await request.json().catch(() => {
      throw new GatewayError("Request body must be JSON", 400, "invalid_json");
    });
    return await handleAgentRequest(apiKey, body);
  } catch (err) {
    return errorResponse(err);
  }
}
