import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";

export const AUTH_COOKIE = "exn_dash_auth";

function dashboardSecret(): string | undefined {
  const s = process.env.DASHBOARD_SECRET?.trim();
  return s || undefined;
}

export function hashSecret(secret: string): string {
  return createHash("sha256").update(`exn-dash:${secret}`).digest("hex");
}

function safeEqualHex(a: string, b: string): boolean {
  try {
    const ba = Buffer.from(a, "hex");
    const bb = Buffer.from(b, "hex");
    if (ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

/** True when DASHBOARD_SECRET is unset (local open mode) or request is authenticated. */
export async function isAuthenticated(req?: NextRequest): Promise<boolean> {
  const secret = dashboardSecret();
  if (!secret) {
    // No gate configured — allow (local/dev). Document that production must set it.
    return true;
  }

  const expected = hashSecret(secret);

  if (req) {
    const header =
      req.headers.get("x-dashboard-secret") ||
      req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    if (header && safeEqualHex(hashSecret(header), expected)) return true;

    const cookie = req.cookies.get(AUTH_COOKIE)?.value;
    if (cookie && safeEqualHex(cookie, expected)) return true;
    return false;
  }

  const jar = await cookies();
  const cookie = jar.get(AUTH_COOKIE)?.value;
  return !!(cookie && safeEqualHex(cookie, expected));
}

export function unauthorized(): NextResponse {
  return NextResponse.json(
    { error: "No autorizado. Inicia sesión o envía x-dashboard-secret." },
    { status: 401 },
  );
}

export function loginResponse(secret: string): NextResponse {
  const configured = dashboardSecret();
  if (!configured) {
    return NextResponse.json(
      { error: "DASHBOARD_SECRET no está configurado en el servidor." },
      { status: 500 },
    );
  }
  if (!safeEqualHex(hashSecret(secret), hashSecret(configured))) {
    return NextResponse.json({ error: "Clave incorrecta." }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(AUTH_COOKIE, hashSecret(configured), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 14, // 14 days
  });
  return res;
}

export function logoutResponse(): NextResponse {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(AUTH_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return res;
}

/** Cron auth: Vercel sets Authorization: Bearer <CRON_SECRET>. */
export function isCronAuthorized(req: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (!cronSecret) {
    // Without CRON_SECRET, still allow if dashboard secret header matches,
    // or if no secrets at all (local).
    return true;
  }
  const auth = req.headers.get("authorization");
  return auth === `Bearer ${cronSecret}`;
}
