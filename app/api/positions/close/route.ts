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
      positionId?: string;
      volume?: string;
    };
    if (!body.positionId) {
      return NextResponse.json(
        { error: "Falta positionId" },
        { status: 400 },
      );
    }
    const client = getClient(req);
    const ack = await client.closePosition(body.positionId, {
      volume: body.volume,
    });
    const operationId = String(ack.operation_id ?? "");
    let operation = null;
    if (operationId) {
      operation = await client.waitForOperation(operationId, {
        timeoutSec: Math.min(settings.pollTimeoutSec, 45),
      });
    }
    pushMovement({
      kind: "close",
      positionId: body.positionId,
      operationId: operationId || undefined,
      volume: body.volume,
      message: `Manual close ${body.positionId}`,
    });
    return NextResponse.json({ ack, operation });
  } catch (err) {
    return jsonError(err);
  }
}
