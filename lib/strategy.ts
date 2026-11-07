/**
 * Placeholder strategy + tick runner for serverless.
 *
 * Forever loops cannot run on Vercel. Instead:
 * - UI (or Vercel Cron) POSTs /api/strategy/tick every ~30–60s
 * - Each tick: if running and no open position for instrument → open tiny buy;
 *   if a managed position exists and held ≥ holdTicks → close it.
 *
 * State is in-memory (module global). Cold starts reset running=false.
 */

import {
  ExnessTraderClient,
  positionId,
  type Settings,
} from "@/lib/exness";
import { pushMovement } from "@/lib/movements";

export type StrategyConfig = {
  running: boolean;
  instrument: string;
  volume: string;
  side: "buy" | "sell";
  /** Ticks to hold before closing (placeholder cadence). */
  holdTicks: number;
  ticksSinceOpen: number;
  managedPositionId: string | null;
  lastTickAt: string | null;
  lastError: string | null;
  tickCount: number;
};

type Store = { state: StrategyConfig };

const g = globalThis as unknown as { __exnStrategy?: Store };

function defaultState(): StrategyConfig {
  return {
    running: false,
    instrument: process.env.EXNESS_INSTRUMENT?.toUpperCase() || "BTCUSD",
    volume: process.env.EXNESS_VOLUME || "0.01",
    side: "buy",
    holdTicks: 3,
    ticksSinceOpen: 0,
    managedPositionId: null,
    lastTickAt: null,
    lastError: null,
    tickCount: 0,
  };
}

function store(): Store {
  if (!g.__exnStrategy) g.__exnStrategy = { state: defaultState() };
  return g.__exnStrategy;
}

export function getStrategyState(): StrategyConfig {
  return { ...store().state };
}

export function updateStrategy(
  patch: Partial<
    Pick<
      StrategyConfig,
      "running" | "instrument" | "volume" | "side" | "holdTicks"
    >
  >,
): StrategyConfig {
  const s = store().state;
  if (patch.instrument != null)
    s.instrument = patch.instrument.toUpperCase();
  if (patch.volume != null) s.volume = String(patch.volume);
  if (patch.side != null) s.side = patch.side;
  if (patch.holdTicks != null)
    s.holdTicks = Math.max(1, Math.min(60, Number(patch.holdTicks) || 3));
  if (patch.running != null) {
    s.running = patch.running;
    if (!patch.running) {
      // Stop does not auto-close; user can close manually.
      pushMovement({
        kind: "strategy",
        instrument: s.instrument,
        message: "Estrategia detenida",
      });
    } else {
      s.lastError = null;
      pushMovement({
        kind: "strategy",
        instrument: s.instrument,
        volume: s.volume,
        side: s.side,
        message: `Estrategia iniciada (${s.instrument} ${s.volume})`,
      });
    }
  }
  return getStrategyState();
}

export type TickResult = {
  state: StrategyConfig;
  action: "noop" | "open" | "close" | "skipped" | "error";
  detail?: string;
};

export async function runStrategyTick(
  client: ExnessTraderClient,
  settings: Settings,
): Promise<TickResult> {
  const s = store().state;
  s.lastTickAt = new Date().toISOString();
  s.tickCount += 1;

  if (!s.running) {
    return { state: getStrategyState(), action: "skipped", detail: "stopped" };
  }

  try {
    const snapshot = await client.getSnapshot();
    const positions = client.extractPositions(snapshot);

    // Reconcile managed id against live book
    if (s.managedPositionId) {
      const stillOpen = positions.some(
        (p) => positionId(p) === s.managedPositionId,
      );
      if (!stillOpen) {
        s.managedPositionId = null;
        s.ticksSinceOpen = 0;
      }
    }

    if (!s.managedPositionId) {
      // Open a tiny market position
      const ack = await client.openPosition({
        instrument: s.instrument,
        side: s.side,
        volume: s.volume,
      });
      const operationId = String(ack.operation_id ?? "");
      if (operationId) {
        const op = await client.waitForOperation(operationId, {
          timeoutSec: Math.min(settings.pollTimeoutSec, 45),
        });
        const status = String(op.status ?? "").toLowerCase();
        if (status === "rejected" || status === "failed") {
          const msg = `Open ${status}`;
          s.lastError = msg;
          pushMovement({
            kind: "error",
            instrument: s.instrument,
            operationId,
            message: msg,
            meta: { status },
          });
          return {
            state: getStrategyState(),
            action: "error",
            detail: msg,
          };
        }
      }

      // Find new position
      const before = new Set(
        positions.map((p) => positionId(p)).filter(Boolean) as string[],
      );
      let openedId: string | null = null;
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const snap2 = await client.getSnapshot();
        const pos2 = client.extractPositions(snap2);
        for (const p of pos2) {
          const pid = positionId(p);
          if (!pid) continue;
          if (!before.has(pid)) {
            openedId = pid;
            break;
          }
          if (
            before.size === 0 &&
            String(p.instrument ?? "").toUpperCase() === s.instrument
          ) {
            openedId = pid;
            break;
          }
        }
        if (openedId) break;
        await new Promise((r) => setTimeout(r, 800));
      }

      s.managedPositionId = openedId;
      s.ticksSinceOpen = 0;
      s.lastError = null;
      pushMovement({
        kind: "open",
        instrument: s.instrument,
        side: s.side,
        volume: s.volume,
        positionId: openedId ?? undefined,
        operationId: operationId || undefined,
        message: openedId
          ? `Estrategia abrió ${s.side} ${s.volume} ${s.instrument}`
          : `Estrategia envió open (posición aún no en snapshot)`,
      });
      return {
        state: getStrategyState(),
        action: "open",
        detail: openedId ?? "pending",
      };
    }

    // Hold then close
    s.ticksSinceOpen += 1;
    if (s.ticksSinceOpen < s.holdTicks) {
      return {
        state: getStrategyState(),
        action: "noop",
        detail: `holding ${s.ticksSinceOpen}/${s.holdTicks}`,
      };
    }

    const pid = s.managedPositionId;
    const closeAck = await client.closePosition(pid);
    const closeOp = String(closeAck.operation_id ?? "");
    if (closeOp) {
      await client.waitForOperation(closeOp, {
        timeoutSec: Math.min(settings.pollTimeoutSec, 45),
      });
    }
    pushMovement({
      kind: "close",
      instrument: s.instrument,
      positionId: pid,
      operationId: closeOp || undefined,
      message: `Estrategia cerró posición ${pid}`,
    });
    s.managedPositionId = null;
    s.ticksSinceOpen = 0;
    s.lastError = null;
    return { state: getStrategyState(), action: "close", detail: pid };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    s.lastError = msg;
    pushMovement({
      kind: "error",
      instrument: s.instrument,
      message: `Tick error: ${msg}`,
    });
    return { state: getStrategyState(), action: "error", detail: msg };
  }
}
