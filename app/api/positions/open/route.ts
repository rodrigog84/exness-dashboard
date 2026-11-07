import { NextRequest, NextResponse } from "next/server";
import { isAuthenticated, unauthorized } from "@/lib/auth";
import { getClient, jsonError, loadSettings } from "@/lib/api";
import { pushMovement } from "@/lib/movements";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  if (!(await isAuthenticated(req))) return unauthorized();
  try {
    const settings = loadSettings();
    const body = (await req.json().catch(() => ({}))) as {
      instrument?: string;
      side?: string;
      volume?: string;
    };
    const instrument = (
      body.instrument ||
      settings.instrument ||
      "BTCUSD"
    ).toUpperCase();
    const side = (body.side || settings.side || "buy").toLowerCase();
    const volume = String(body.volume || settings.volume || "0.01");

    if (side !== "buy" && side !== "sell") {
      return NextResponse.json({ error: "side inválido" }, { status: 400 });
    }

    const client = getClient();
    await client.discoverAccessPoint();
    const ack = await client.openPosition({ instrument, side, volume });
    const operationId = String(ack.operation_id ?? "");
    let operation = null;
    if (operationId) {
      operation = await client.waitForOperation(operationId, {
        timeoutSec: Math.min(settings.pollTimeoutSec, 45),
      });
    }
    pushMovement({
      kind: "open",
      instrument,
      side,
      volume,
      operationId: operationId || undefined,
      message: `Manual open ${side} ${volume} ${instrument}`,
    });
    return NextResponse.json({ ack, operation });
  } catch (err) {
    return jsonError(err);
  }
}
