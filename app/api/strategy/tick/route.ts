import { NextRequest, NextResponse } from "next/server";
import { isAuthenticated, unauthorized } from "@/lib/auth";
import { getClient, jsonError, loadSettings } from "@/lib/api";
import { runStrategyTick } from "@/lib/strategy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * One robot step (open if flat, else SL/TP/timeout close).
 * Call from the UI poller (required on Hobby) or optional Pro cron.
 * Serverless-safe: no forever loop. loadSettings() refuses live without ALLOW_LIVE.
 */
export async function POST(req: NextRequest) {
  if (!(await isAuthenticated(req))) return unauthorized();
  try {
    const settings = loadSettings();
    const client = getClient();
    await client.discoverAccessPoint();
    const result = await runStrategyTick(client, settings);
    return NextResponse.json(result);
  } catch (err) {
    return jsonError(err);
  }
}
