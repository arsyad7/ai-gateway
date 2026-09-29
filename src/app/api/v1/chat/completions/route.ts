import { authenticateGatewayKey } from "@/lib/auth";
import { errorResponse, handleChat } from "@/lib/gateway";
import { GatewayError } from "@/lib/types";

export const runtime = "nodejs";
// Streaming responses can run long.
export const maxDuration = 300;

export async function POST(request: Request): Promise<Response> {
  try {
    const apiKey = await authenticateGatewayKey(request);
    const body = await request.json().catch(() => {
      throw new GatewayError("Request body must be JSON", 400, "invalid_json");
    });
    return await handleChat(apiKey, body);
  } catch (err) {
    return errorResponse(err);
  }
}
