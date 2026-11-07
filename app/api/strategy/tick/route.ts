import { NextRequest, NextResponse } from "next/server";
import { isAuthenticated, unauthorized } from "@/lib/auth";
import { getClient, jsonError, loadSettings } from "@/lib/api";
import { runStrategyTick } from "@/lib/strategy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * One strategy step. Call from the UI poller or externally.
 * Serverless-safe: no forever loop.
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
