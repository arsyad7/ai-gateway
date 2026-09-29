import { requireAdmin } from "@/lib/auth";
import { errorResponse } from "@/lib/gateway";
import { GatewayError } from "@/lib/types";

/** Wraps an admin handler with the session check and error mapping. */
export function adminRoute<T extends unknown[]>(
  handler: (...args: T) => Promise<Response>,
): (...args: T) => Promise<Response> {
  return async (...args: T) => {
    try {
      await requireAdmin();
      return await handler(...args);
    } catch (err) {
      return errorResponse(err);
    }
  };
}

export function badRequest(message: string): never {
  throw new GatewayError(message, 400, "invalid_request");
}

const PERIODS = new Set(["daily", "weekly", "monthly", "total"]);

export function validPeriod(period: unknown): string {
  const p = typeof period === "string" && period ? period : "monthly";
  if (!PERIODS.has(p)) badRequest(`period must be one of: ${[...PERIODS].join(", ")}`);
  return p;
}

export function optionalNumber(value: unknown, field: string): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) badRequest(`${field} must be a non-negative number`);
  return n;
}
