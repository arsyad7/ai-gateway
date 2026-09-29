import { GatewayError } from "@/lib/types";

/** 429 and 5xx are worth retrying on another model; 4xx generally is not. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

export function upstreamError(
  provider: string,
  status: number,
  detail: string,
): GatewayError {
  return new GatewayError(
    `${provider} upstream error (${status}): ${detail}`.slice(0, 900),
    // Surface auth/config problems as 502 so a client never sees a bare 401
    // from us and mistakes it for their own key being wrong.
    status === 401 || status === 403 ? 502 : status,
    `upstream_${status}`,
    isRetryableStatus(status),
  );
}

export function networkError(provider: string, err: unknown): GatewayError {
  const msg = err instanceof Error ? err.message : String(err);
  return new GatewayError(
    `${provider} unreachable: ${msg}`,
    502,
    "upstream_unreachable",
    true,
  );
}

/** Reads the most useful message out of a JSON or text error body. */
export async function readErrorBody(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const json = JSON.parse(text);
    return (
      json?.error?.message ??
      json?.error?.status ??
      json?.message ??
      json?.[0]?.error?.message ??
      text
    );
  } catch {
    return text || res.statusText;
  }
}
