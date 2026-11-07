import { NextRequest, NextResponse } from "next/server";
import { isCronAuthorized } from "@/lib/auth";
import { getClient, jsonError, loadSettings } from "@/lib/api";
import { getStrategyState, runStrategyTick } from "@/lib/strategy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Optional Vercel Cron entry (disabled on Hobby; re-enable minute cron on Pro).
 * Auth: Authorization: Bearer $CRON_SECRET (set automatically on Vercel).
 * No-ops when strategy is stopped.
 */
export async function GET(req: NextRequest) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized cron" }, { status: 401 });
  }
  try {
    const state = getStrategyState();
    if (!state.running) {
      return NextResponse.json({
        skipped: true,
        reason: "strategy_stopped",
        strategy: state,
      });
    }
    const settings = loadSettings();
    const client = getClient();
    await client.discoverAccessPoint();
    const result = await runStrategyTick(client, settings);
    return NextResponse.json(result);
  } catch (err) {
    return jsonError(err);
  }
}
