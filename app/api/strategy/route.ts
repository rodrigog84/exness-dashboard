import { NextRequest, NextResponse } from "next/server";
import { isAuthenticated, unauthorized } from "@/lib/auth";
import {
  getStrategyState,
  updateStrategy,
  type EntryMode,
} from "@/lib/strategy";
import type { TrendParams } from "@/lib/trend/params";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!(await isAuthenticated(req))) return unauthorized();
  return NextResponse.json({ strategy: getStrategyState() });
}

/**
 * Start / stop robot and update params.
 * Body: { running?, instrument?, volume?, side?, entryMode?, holdTicks?,
 *         slPct?, slUsd?, tpPct?, tpUsd?, trend?: Partial<TrendParams> }
 * Env defaults apply when fields are omitted (see .env.example).
 */
export async function POST(req: NextRequest) {
  if (!(await isAuthenticated(req))) return unauthorized();
  const body = (await req.json().catch(() => ({}))) as {
    running?: boolean;
    instrument?: string;
    volume?: string;
    side?: "buy" | "sell";
    entryMode?: EntryMode;
    holdTicks?: number;
    slPct?: number;
    slUsd?: number;
    tpPct?: number;
    tpUsd?: number;
    trend?: Partial<TrendParams>;
  };
  const strategy = updateStrategy(body);
  return NextResponse.json({ strategy });
}
