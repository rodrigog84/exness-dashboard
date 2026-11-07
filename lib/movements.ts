/**
 * In-memory recent movements log (opens/closes/PnL when known).
 * Cold starts on serverless reset this — documented in README.
 */

export type Movement = {
  id: string;
  at: string;
  kind: "open" | "close" | "strategy" | "info" | "error";
  instrument?: string;
  side?: string;
  volume?: string;
  positionId?: string;
  operationId?: string;
  pnl?: string | number | null;
  /** Close reason from the robot: sl | tp | timeout */
  reason?: "sl" | "tp" | "timeout";
  message: string;
  meta?: Record<string, unknown>;
};

const MAX = 80;

type Store = { items: Movement[] };

const g = globalThis as unknown as { __exnMovements?: Store };

function store(): Store {
  if (!g.__exnMovements) g.__exnMovements = { items: [] };
  return g.__exnMovements;
}

export function listMovements(limit = 40): Movement[] {
  return store().items.slice(0, limit);
}

export function pushMovement(
  entry: Omit<Movement, "id" | "at"> & { at?: string },
): Movement {
  const m: Movement = {
    id: `m-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: entry.at ?? new Date().toISOString(),
    kind: entry.kind,
    instrument: entry.instrument,
    side: entry.side,
    volume: entry.volume,
    positionId: entry.positionId,
    operationId: entry.operationId,
    pnl: entry.pnl ?? null,
    reason: entry.reason,
    message: entry.message,
    meta: entry.meta,
  };
  const s = store();
  s.items.unshift(m);
  if (s.items.length > MAX) s.items.length = MAX;
  return m;
}
