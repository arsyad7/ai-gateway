import type { ProviderAdapter } from "@/lib/types";
import { GatewayError } from "@/lib/types";
import { anthropicAdapter } from "@/lib/providers/anthropic";
import { claudeCliAdapter } from "@/lib/providers/claudeCli";
import { codexCliAdapter } from "@/lib/providers/codexCli";
import { googleAdapter } from "@/lib/providers/google";
import {
  openaiAdapter,
  openaiCompatibleAdapter,
} from "@/lib/providers/openai";

const adapters: Record<string, ProviderAdapter> = {
  anthropic: anthropicAdapter,
  openai: openaiAdapter,
  google: googleAdapter,
  openai_compatible: openaiCompatibleAdapter,
  claude_cli: claudeCliAdapter,
  codex_cli: codexCliAdapter,
};

/** Providers that run a local CLI under the user's own login: no API key. */
export const CLI_KINDS = ["claude_cli", "codex_cli"];

export const PROVIDER_KINDS = Object.keys(adapters);

export function getAdapter(kind: string): ProviderAdapter {
  const adapter = adapters[kind];
  if (!adapter) {
    throw new GatewayError(
      `Unknown provider kind '${kind}'`,
      500,
      "unknown_provider",
    );
  }
  return adapter;
}
