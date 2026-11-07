import { NextRequest } from "next/server";
import { loginResponse } from "@/lib/auth";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { secret?: string };
  const secret = body.secret?.trim() || "";
  if (!secret) {
    return Response.json({ error: "Falta secret." }, { status: 400 });
  }
  return loginResponse(secret);
}
