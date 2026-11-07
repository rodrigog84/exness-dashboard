import { NextRequest, NextResponse } from "next/server";
import { isAuthenticated, unauthorized } from "@/lib/auth";
import { getStrategyState, updateStrategy } from "@/lib/strategy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!(await isAuthenticated(req))) return unauthorized();
  return NextResponse.json({ strategy: getStrategyState() });
}

export async function POST(req: NextRequest) {
  if (!(await isAuthenticated(req))) return unauthorized();
  const body = (await req.json().catch(() => ({}))) as {
    running?: boolean;
    instrument?: string;
    volume?: string;
    side?: "buy" | "sell";
    holdTicks?: number;
  };
  const strategy = updateStrategy(body);
  return NextResponse.json({ strategy });
}
