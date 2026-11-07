import { NextRequest, NextResponse } from "next/server";
import { isAuthenticated, unauthorized } from "@/lib/auth";
import { getClient, jsonError, loadSettings, mapPositions } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!(await isAuthenticated(req))) return unauthorized();
  try {
    const settings = loadSettings();
    const client = getClient(req);
    await client.discoverAccessPoint();
    const [account, snapshot] = await Promise.all([
      client.getAccount(),
      client.getSnapshot(),
    ]);
    const state = client.extractAccountState(snapshot);
    const positions = client.extractPositions(snapshot);
    return NextResponse.json({
      env: settings.envMode,
      accountId: settings.accountId,
      account,
      accountState: {
        balance: state.balance ?? null,
        equity: state.equity ?? null,
        margin: state.margin ?? state.used_margin ?? null,
        freeMargin: state.free_margin ?? null,
        marginLevel: state.margin_level ?? null,
        currency:
          state.currency ??
          account.currency ??
          account.account_currency ??
          null,
        raw: state,
      },
      openPositionCount: positions.length,
      positions: mapPositions(client, snapshot),
      accessPoint: client.knownAccessPoint(),
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    return jsonError(err);
  }
}
