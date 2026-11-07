import { NextRequest, NextResponse } from "next/server";
import {
  ExnessApiError,
  ExnessConfigError,
  ExnessTraderClient,
  loadSettings,
  positionId,
} from "@/lib/exness";

export const ACCESS_POINT_HEADER = "x-exn-ap";

/** Singleton-ish client per isolate (caches access_point). */
const g = globalThis as unknown as {
  __exnClient?: ExnessTraderClient;
};

/**
 * One client per isolate. When the request carries an access point the browser
 * remembered (header x-exn-ap), it seeds the cache so a cold start does not
 * have to hit the rate-limited discovery endpoint.
 */
export function getClient(req?: NextRequest): ExnessTraderClient {
  if (!g.__exnClient) {
    g.__exnClient = new ExnessTraderClient();
  }
  if (req) g.__exnClient.seedAccessPoint(req.headers.get(ACCESS_POINT_HEADER));
  return g.__exnClient;
}

export function mapPositions(
  client: ExnessTraderClient,
  snapshot: Record<string, unknown>,
) {
  return client.extractPositions(snapshot).map((p) => ({
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
}

export function resetClient(): void {
  g.__exnClient = undefined;
}

export function jsonError(err: unknown): NextResponse {
  if (err instanceof ExnessConfigError) {
    return NextResponse.json(
      { error: err.message, code: "config" },
      { status: 500 },
    );
  }
  if (err instanceof ExnessApiError) {
    const headers: Record<string, string> = {};
    if (err.statusCode === 429 && err.retryAfterSec) {
      headers["Retry-After"] = String(err.retryAfterSec);
    }
    return NextResponse.json(
      {
        error: err.message,
        code: err.errorCode ?? "api",
        statusCode: err.statusCode,
        retryAfterSec: err.retryAfterSec,
        body: err.body,
      },
      {
        status: err.statusCode && err.statusCode < 500 ? err.statusCode : 502,
        headers,
      },
    );
  }
  return NextResponse.json(
    { error: err instanceof Error ? err.message : String(err) },
    { status: 500 },
  );
}

export { loadSettings };
