import { NextRequest, NextResponse } from "next/server";
import { isAuthenticated, unauthorized } from "@/lib/auth";
import { getClient, jsonError, loadSettings } from "@/lib/api";
import { hydrateStrategy, runStrategyTick } from "@/lib/strategy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * One robot step (open if flat, else SL/TP/timeout close).
 * Call from the UI poller (required on Hobby) or optional Pro cron.
 * Stateless: the client sends its full robot state in `{ strategy }` and gets
 * the updated state back, so cold starts / other instances lose nothing.
 * Without a body, falls back to the in-memory state (legacy / cron).
 * Serverless-safe: no forever loop. loadSettings() refuses live without ALLOW_LIVE.
 */
export async function POST(req: NextRequest) {
  if (!(await isAuthenticated(req))) return unauthorized();
  const body = (await req.json().catch(() => null)) as {
    strategy?: unknown;
  } | null;
  try {
    if (body?.strategy) hydrateStrategy(body.strategy);
    const settings = loadSettings();
    const client = getClient();
    await client.discoverAccessPoint();
    const result = await runStrategyTick(client, settings);
    return NextResponse.json(result);
  } catch (err) {
    return jsonError(err);
  }
}
