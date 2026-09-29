import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import type { ApiKey } from "@prisma/client";
import { prisma } from "@/lib/db";
import { sha256 } from "@/lib/crypto";
import { GatewayError } from "@/lib/types";

export const SESSION_COOKIE = "gw_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function sessionSecret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error("SESSION_SECRET is not set");
  return s;
}

function sign(payload: string): string {
  return createHmac("sha256", sessionSecret()).update(payload).digest("base64url");
}

export function mintSessionToken(): string {
  const payload = `admin.${Date.now() + SESSION_TTL_MS}`;
  return `${Buffer.from(payload).toString("base64url")}.${sign(payload)}`;
}

export function verifySessionToken(token: string | undefined): boolean {
  if (!token) return false;
  const [encoded, mac] = token.split(".");
  if (!encoded || !mac) return false;

  const payload = Buffer.from(encoded, "base64url").toString("utf8");
  const expected = sign(payload);
  if (
    expected.length !== mac.length ||
    !timingSafeEqual(Buffer.from(expected), Buffer.from(mac))
  ) {
    return false;
  }

  const [subject, expiry] = payload.split(".");
  return subject === "admin" && Number(expiry) > Date.now();
}

export async function isAdmin(): Promise<boolean> {
  const jar = await cookies();
  return verifySessionToken(jar.get(SESSION_COOKIE)?.value);
}

/** Guard for every /api/admin route. */
export async function requireAdmin(): Promise<void> {
  if (!(await isAdmin())) {
    throw new GatewayError("Not authenticated", 401, "unauthorized");
  }
}

/** Resolves the Bearer token on a gateway request to an ApiKey row. */
export async function authenticateGatewayKey(
  request: Request,
): Promise<ApiKey> {
  const header =
    request.headers.get("authorization") ??
    request.headers.get("x-api-key") ??
    "";
  const raw = header.replace(/^Bearer\s+/i, "").trim();

  if (!raw) {
    throw new GatewayError(
      "Missing API key. Send 'Authorization: Bearer <gateway key>'.",
      401,
      "missing_api_key",
    );
  }

  const key = await prisma.apiKey.findUnique({ where: { keyHash: sha256(raw) } });
  if (!key) throw new GatewayError("Invalid API key", 401, "invalid_api_key");
  if (!key.enabled) {
    throw new GatewayError("API key is disabled", 403, "key_disabled");
  }

  // Fire-and-forget: a failed touch must not fail the request.
  prisma.apiKey
    .update({ where: { id: key.id }, data: { lastUsedAt: new Date() } })
    .catch(() => {});

  return key;
}
