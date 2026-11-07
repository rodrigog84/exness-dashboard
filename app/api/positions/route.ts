import { NextRequest, NextResponse } from "next/server";
import { isAuthenticated, unauthorized } from "@/lib/auth";
import { getClient, jsonError, mapPositions } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!(await isAuthenticated(req))) return unauthorized();
  try {
    const client = getClient(req);
    const snapshot = await client.getSnapshot();
    const positions = mapPositions(client, snapshot);
    return NextResponse.json({
      positions,
      accessPoint: client.knownAccessPoint(),
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    return jsonError(err);
  }
}
