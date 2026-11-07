import { NextResponse } from "next/server";
import {
  ExnessApiError,
  ExnessConfigError,
  ExnessTraderClient,
  loadSettings,
} from "@/lib/exness";

/** Singleton-ish client per isolate (caches access_point). */
const g = globalThis as unknown as {
  __exnClient?: ExnessTraderClient;
};

export function getClient(): ExnessTraderClient {
  if (!g.__exnClient) {
    g.__exnClient = new ExnessTraderClient();
  }
  return g.__exnClient;
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
    return NextResponse.json(
      {
        error: err.message,
        code: err.errorCode ?? "api",
        statusCode: err.statusCode,
        body: err.body,
      },
      { status: err.statusCode && err.statusCode < 500 ? err.statusCode : 502 },
    );
  }
  return NextResponse.json(
    { error: err instanceof Error ? err.message : String(err) },
    { status: 500 },
  );
}

export { loadSettings };
