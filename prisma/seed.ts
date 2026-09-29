/**
 * Seeds providers/models from env keys if present, so a fresh install has
 * something to route to. Safe to re-run: existing rows are left alone.
 * Prices below are the published per-MTok rates at the time of writing —
 * adjust in the dashboard if they drift.
 */
import { PrismaClient } from "@prisma/client";
import { createCipheriv, randomBytes, scryptSync } from "node:crypto";

const prisma = new PrismaClient();

function encryptSecret(plaintext: string): string {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) throw new Error("ENCRYPTION_KEY is not set");
  const key = /^[0-9a-f]{64}$/i.test(raw)
    ? Buffer.from(raw, "hex")
    : scryptSync(raw, "ai-gateway.v1", 32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    enc.toString("base64"),
  ].join(".");
}

type SeedModel = {
  alias: string;
  upstreamModel: string;
  inputPricePerMTok: number;
  outputPricePerMTok: number;
  tags: string;
  reasoning?: boolean;
  priority?: number;
};

const catalogs: {
  env: string;
  name: string;
  kind: string;
  models: SeedModel[];
}[] = [
  {
    env: "ANTHROPIC_API_KEY",
    name: "anthropic",
    kind: "anthropic",
    models: [
      {
        alias: "claude-opus-5",
        upstreamModel: "claude-opus-5",
        inputPricePerMTok: 5,
        outputPricePerMTok: 25,
        tags: "smart,reasoning",
        reasoning: true,
        priority: 10,
      },
      {
        alias: "claude-sonnet-5",
        upstreamModel: "claude-sonnet-5",
        inputPricePerMTok: 3,
        outputPricePerMTok: 15,
        tags: "balanced,reasoning",
        reasoning: true,
        priority: 20,
      },
      {
        alias: "claude-haiku-4-5",
        upstreamModel: "claude-haiku-4-5",
        inputPricePerMTok: 1,
        outputPricePerMTok: 5,
        tags: "cheap,fast",
        priority: 30,
      },
    ],
  },
  {
    env: "OPENAI_API_KEY",
    name: "openai",
    kind: "openai",
    models: [
      {
        alias: "gpt-5",
        upstreamModel: "gpt-5",
        inputPricePerMTok: 1.25,
        outputPricePerMTok: 10,
        tags: "smart,reasoning",
        reasoning: true,
        priority: 10,
      },
      {
        alias: "gpt-5-mini",
        upstreamModel: "gpt-5-mini",
        inputPricePerMTok: 0.25,
        outputPricePerMTok: 2,
        tags: "cheap,fast",
        priority: 20,
      },
    ],
  },
  {
    env: "GOOGLE_API_KEY",
    name: "google",
    kind: "google",
    models: [
      {
        alias: "gemini-2.5-pro",
        upstreamModel: "gemini-2.5-pro",
        inputPricePerMTok: 1.25,
        outputPricePerMTok: 10,
        tags: "smart,reasoning",
        reasoning: true,
        priority: 10,
      },
      {
        alias: "gemini-2.5-flash",
        upstreamModel: "gemini-2.5-flash",
        inputPricePerMTok: 0.3,
        outputPricePerMTok: 2.5,
        tags: "cheap,fast",
        priority: 20,
      },
    ],
  },
];

async function main() {
  for (const cat of catalogs) {
    const apiKey = process.env[cat.env];
    if (!apiKey) {
      console.log(`- ${cat.name}: ${cat.env} not set, skipping`);
      continue;
    }
    let provider = await prisma.provider.findUnique({ where: { name: cat.name } });
    if (!provider) {
      provider = await prisma.provider.create({
        data: { name: cat.name, kind: cat.kind, apiKeyEnc: encryptSecret(apiKey) },
      });
      console.log(`+ provider ${cat.name}`);
    }
    for (const m of cat.models) {
      const exists = await prisma.model.findUnique({ where: { alias: m.alias } });
      if (exists) continue;
      await prisma.model.create({
        data: {
          providerId: provider.id,
          alias: m.alias,
          upstreamModel: m.upstreamModel,
          inputPricePerMTok: m.inputPricePerMTok,
          outputPricePerMTok: m.outputPricePerMTok,
          tags: m.tags,
          reasoning: m.reasoning ?? false,
          priority: m.priority ?? 100,
        },
      });
      console.log(`  + model ${m.alias}`);
    }
  }
  console.log("Seed done.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
