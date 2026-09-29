import { timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { mintSessionToken, SESSION_COOKIE } from "@/lib/auth";

export const runtime = "nodejs";

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export async function POST(request: Request): Promise<Response> {
  const { password } = await request.json().catch(() => ({ password: "" }));
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) {
    return Response.json(
      { error: { message: "ADMIN_PASSWORD is not configured on the server" } },
      { status: 500 },
    );
  }
  if (typeof password !== "string" || !safeEqual(password, expected)) {
    return Response.json(
      { error: { message: "Wrong password" } },
      { status: 401 },
    );
  }
  const jar = await cookies();
  jar.set(SESSION_COOKIE, mintSessionToken(), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 12 * 60 * 60,
  });
  return Response.json({ ok: true });
}

export async function DELETE(): Promise<Response> {
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
  return Response.json({ ok: true });
}
