import { prisma } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const startedAt = Date.now();

/**
 * Unauthenticated liveness + readiness probe. Used by scripts/watchdog.ps1
 * and any uptime monitor. Returns 503 when the database cannot be reached so
 * a "running but broken" server is restarted like a dead one.
 */
export async function GET(): Promise<Response> {
  const checks: Record<string, "ok" | "fail"> = {};
  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.db = "ok";
  } catch {
    checks.db = "fail";
  }
  const ok = Object.values(checks).every((c) => c === "ok");
  return Response.json(
    {
      status: ok ? "ok" : "degraded",
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
      pid: process.pid,
      checks,
      time: new Date().toISOString(),
    },
    { status: ok ? 200 : 503, headers: { "cache-control": "no-store" } },
  );
}
