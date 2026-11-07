import { NextRequest, NextResponse } from "next/server";
import { isAuthenticated, unauthorized } from "@/lib/auth";
import { getClient, jsonError } from "@/lib/api";
import { positionId } from "@/lib/exness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!(await isAuthenticated(req))) return unauthorized();
  try {
    const client = getClient();
    await client.discoverAccessPoint();
    const snapshot = await client.getSnapshot();
    const positions = client.extractPositions(snapshot).map((p) => ({
      id: positionId(p),
      instrument: p.instrument ?? null,
      side: p.side ?? null,
      volume: p.volume ?? null,
      openPrice: p.open_price ?? p.price ?? null,
      currentPrice: p.current_price ?? p.mark_price ?? null,
      profit: p.profit ?? p.unrealized_pnl ?? p.pnl ?? null,
      swap: p.swap ?? null,
      raw: p,
    }));
    return NextResponse.json({
      positions,
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    return jsonError(err);
  }
}
