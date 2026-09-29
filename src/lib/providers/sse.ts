/**
 * Yields the payload of each `data:` line in an SSE response body.
 * Stops at the `[DONE]` sentinel used by OpenAI-compatible servers.
 */
export async function* iterateSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Events are separated by a blank line; a line may be split across chunks,
      // so only consume up to the last newline we have.
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") return;
        if (payload) yield payload;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Formats one OpenAI-style SSE frame for the gateway's own responses. */
export function sseFrame(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

export const SSE_DONE = "data: [DONE]\n\n";
