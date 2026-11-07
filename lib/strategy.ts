/**
 * Automatic demo robot + tick runner for serverless.
 *
 * Forever loops cannot run on Vercel. Instead:
 * - UI keeps POSTing /api/strategy/tick while running (Hobby has no minute cron)
 * - entryMode "trend" (default): trend-following on closed 1h/4h candles, see
 *   lib/trend/runner.ts (EMA cross + EMA trend filter, ATR stop, R-based TP /
 *   trailing, risk-based sizing, daily-loss / cooldown / spread brakes).
 * - Legacy modes (alternate / random / fixed): if flat → open market; if in a
 *   managed position → close on SL, optional TP, or max-hold timeout.
 * - tickStrategy(client, settings, state) is a pure state-in/state-out step with
 *   no browser dependency: a future cron / worker only has to persist `state`.
 *
 * The client is the source of truth: it persists the robot state in
 * localStorage and sends the full state with every tick (hydrateStrategy), so
 * serverless cold starts / multiple instances never reset `running`.
 * The module global is only a per-invocation scratchpad.
 */

import {
  ExnessApiError,
  ExnessTraderClient,
  positionId,
  type Settings,
} from "@/lib/exness";
import { pushMovement } from "@/lib/movements";
import {
  DEFAULT_TREND,
  defaultRuntime,
  sanitizeRuntime,
  sanitizeTrendParams,
  type CloseReason,
  type TrendParams,
  type TrendRuntime,
} from "@/lib/trend/params";
import { tickTrend, type TickLog, type TrendTickDeps } from "@/lib/trend/runner";

export type { CloseReason } from "@/lib/trend/params";
export type EntryMode = "trend" | "alternate" | "random" | "fixed";
export type RobotStatus = "flat" | "in_position" | "opening" | "closing";

export type StrategyConfig = {
  running: boolean;
  instrument: string;
  volume: string;
  /** Next / fixed side when entryMode is fixed; also last opened side. */
  side: "buy" | "sell";
  entryMode: EntryMode;
  /** Max ticks to hold before timeout close. */
  holdTicks: number;
  /** Price stop-loss percent of open_price (e.g. 0.3 = −0.3%). 0 = disabled. */
  slPct: number;
  /** Optional fixed $ unrealized loss that triggers SL. 0 = disabled. */
  slUsd: number;
  /** Optional take-profit percent of open_price. 0 = disabled. */
  tpPct: number;
  /** Optional fixed $ unrealized profit that triggers TP. 0 = disabled. */
  tpUsd: number;
  /** Trend-following parameters (entryMode "trend"). */
  trend: TrendParams;
  /** Trend-following runtime state (indicators, brakes, position plan). */
  trendRuntime: TrendRuntime;
  ticksSinceOpen: number;
  managedPositionId: string | null;
  managedSide: "buy" | "sell" | null;
  openPrice: number | null;
  lastTickAt: string | null;
  lastError: string | null;
  lastAction: string | null;
  lastCloseReason: CloseReason | null;
  status: RobotStatus;
  tickCount: number;
  /** Position ids seen before an open order was sent; used to adopt an unconfirmed open instead of duplicating it. */
  pendingBefore: string[] | null;
};

type Store = { state: StrategyConfig };

const g = globalThis as unknown as { __exnStrategy?: Store };

function envNum(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function envEntryMode(): EntryMode {
  const raw = (process.env.EXNESS_ENTRY_MODE || "trend").toLowerCase();
  if (
    raw === "random" ||
    raw === "fixed" ||
    raw === "alternate" ||
    raw === "trend"
  ) {
    return raw;
  }
  return "trend";
}

function envTrendParams(): TrendParams {
  return sanitizeTrendParams({
    timeframeHours: envNum("TREND_TIMEFRAME_HOURS", DEFAULT_TREND.timeframeHours),
    riskPct: envNum("TREND_RISK_PCT", DEFAULT_TREND.riskPct),
    maxVolume: envNum("TREND_MAX_VOLUME", DEFAULT_TREND.maxVolume),
    maxSpreadPct: envNum("TREND_MAX_SPREAD_PCT", DEFAULT_TREND.maxSpreadPct),
    cooldownCandles: envNum("TREND_COOLDOWN_CANDLES", DEFAULT_TREND.cooldownCandles),
    dailyLossPct: envNum("TREND_DAILY_LOSS_PCT", DEFAULT_TREND.dailyLossPct),
    tpR: envNum("TREND_TP_R", DEFAULT_TREND.tpR),
    candleSource: process.env.TREND_CANDLE_SOURCE,
  });
}

function defaultState(): StrategyConfig {
  const sideRaw = (process.env.EXNESS_SIDE || "buy").toLowerCase();
  const side = sideRaw === "sell" ? "sell" : "buy";
  return {
    running: false,
    instrument: process.env.EXNESS_INSTRUMENT?.toUpperCase() || "BTCUSD",
    volume: process.env.EXNESS_VOLUME || "0.01",
    side,
    entryMode: envEntryMode(),
    holdTicks: Math.max(1, Math.min(120, envNum("EXNESS_HOLD_TICKS", 10))),
    slPct: Math.max(0, envNum("EXNESS_SL_PCT", 0.3)),
    slUsd: Math.max(0, envNum("EXNESS_SL_USD", 0)),
    tpPct: Math.max(0, envNum("EXNESS_TP_PCT", 0)),
    tpUsd: Math.max(0, envNum("EXNESS_TP_USD", 0)),
    trend: envTrendParams(),
    trendRuntime: defaultRuntime(),
    ticksSinceOpen: 0,
    managedPositionId: null,
    managedSide: null,
    openPrice: null,
    lastTickAt: null,
    lastError: null,
    lastAction: null,
    lastCloseReason: null,
    status: "flat",
    tickCount: 0,
    pendingBefore: null,
  };
}

function store(): Store {
  if (!g.__exnStrategy) g.__exnStrategy = { state: defaultState() };
  return g.__exnStrategy;
}

export function getStrategyState(): StrategyConfig {
  return structuredClone(store().state);
}

function snapshotState(s: StrategyConfig): StrategyConfig {
  return structuredClone(s);
}

export type StrategyPatch = Partial<
  Pick<
    StrategyConfig,
    | "running"
    | "instrument"
    | "volume"
    | "side"
    | "entryMode"
    | "holdTicks"
    | "slPct"
    | "slUsd"
    | "tpPct"
    | "tpUsd"
  >
> & { trend?: Partial<TrendParams> };

function clampPct(n: number): number {
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(50, n);
}

function clampUsd(n: number): number {
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(1_000_000, n);
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

function numOrNull(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Replace server state with the (sanitized) state sent by the client.
 * Missing / invalid fields fall back to env defaults.
 */
export function hydrateStrategy(input: unknown): StrategyConfig {
  const base = defaultState();
  if (!input || typeof input !== "object") {
    store().state = base;
    return getStrategyState();
  }
  const i = input as Record<string, unknown>;
  const mode = String(i.entryMode ?? "").toLowerCase();
  const hasTrend = i.trend != null && typeof i.trend === "object";
  const status = String(i.status ?? "");
  const closeReason = String(i.lastCloseReason ?? "");
  const managedSide = String(i.managedSide ?? "");
  const side = String(i.side ?? "");
  const s: StrategyConfig = {
    ...base,
    running: i.running === true,
    instrument: strOrNull(i.instrument)?.toUpperCase() ?? base.instrument,
    volume: strOrNull(i.volume) ?? base.volume,
    side: side === "sell" ? "sell" : side === "buy" ? "buy" : base.side,
    entryMode:
      mode === "random" || mode === "fixed" || mode === "alternate" || mode === "trend"
        ? mode
        : base.entryMode,
    holdTicks:
      numOrNull(i.holdTicks) != null
        ? Math.max(1, Math.min(120, Number(i.holdTicks)))
        : base.holdTicks,
    slPct: numOrNull(i.slPct) != null ? clampPct(Number(i.slPct)) : base.slPct,
    slUsd: numOrNull(i.slUsd) != null ? clampUsd(Number(i.slUsd)) : base.slUsd,
    tpPct: numOrNull(i.tpPct) != null ? clampPct(Number(i.tpPct)) : base.tpPct,
    tpUsd: numOrNull(i.tpUsd) != null ? clampUsd(Number(i.tpUsd)) : base.tpUsd,
    trend: hasTrend
      ? sanitizeTrendParams(i.trend, base.trend)
      : base.trend,
    trendRuntime: sanitizeRuntime(i.trendRuntime),
    ticksSinceOpen: Math.max(0, Math.floor(numOrNull(i.ticksSinceOpen) ?? 0)),
    managedPositionId: strOrNull(i.managedPositionId),
    managedSide:
      managedSide === "buy" || managedSide === "sell" ? managedSide : null,
    openPrice: numOrNull(i.openPrice),
    lastTickAt: strOrNull(i.lastTickAt),
    lastError: strOrNull(i.lastError),
    lastAction: strOrNull(i.lastAction),
    lastCloseReason: (
      ["sl", "tp", "timeout", "trail", "cross", "broker"] as const
    ).includes(closeReason as CloseReason)
      ? (closeReason as CloseReason)
      : null,
    status:
      status === "in_position" ||
      status === "opening" ||
      status === "closing" ||
      status === "flat"
        ? status
        : "flat",
    tickCount: Math.max(0, Math.floor(numOrNull(i.tickCount) ?? 0)),
    pendingBefore: Array.isArray(i.pendingBefore)
      ? i.pendingBefore.filter((x): x is string => typeof x === "string")
      : null,
  };
  if (!s.managedPositionId) {
    s.status = "flat";
    s.trendRuntime.pos = null;
  } else {
    s.status = "in_position";
  }
  store().state = s;
  return getStrategyState();
}

export function updateStrategy(patch: StrategyPatch): StrategyConfig {
  const s = store().state;
  if (patch.instrument != null)
    s.instrument = String(patch.instrument).toUpperCase();
  if (patch.volume != null) s.volume = String(patch.volume);
  if (patch.side != null) s.side = patch.side;
  if (patch.entryMode != null) {
    const m = String(patch.entryMode).toLowerCase();
    if (m === "alternate" || m === "random" || m === "fixed" || m === "trend") {
      s.entryMode = m;
    }
  }
  if (patch.trend) s.trend = sanitizeTrendParams(patch.trend, s.trend);
  if (patch.holdTicks != null)
    s.holdTicks = Math.max(1, Math.min(120, Number(patch.holdTicks) || 10));
  if (patch.slPct != null) s.slPct = clampPct(Number(patch.slPct));
  if (patch.slUsd != null) s.slUsd = clampUsd(Number(patch.slUsd));
  if (patch.tpPct != null) s.tpPct = clampPct(Number(patch.tpPct));
  if (patch.tpUsd != null) s.tpUsd = clampUsd(Number(patch.tpUsd));
  if (patch.running != null) {
    s.running = patch.running;
    if (!patch.running) {
      s.status = s.managedPositionId ? "in_position" : "flat";
      s.lastAction = "stop";
      pushMovement({
        kind: "strategy",
        instrument: s.instrument,
        message: "Robot detenido (posiciones abiertas no se cierran)",
        meta: { action: "stop" },
      });
    } else {
      s.lastError = null;
      s.lastAction = "start";
      s.status = s.managedPositionId ? "in_position" : "flat";
      pushMovement({
        kind: "strategy",
        instrument: s.instrument,
        volume: s.volume,
        side: s.side,
        message: `Robot iniciado (${s.instrument} ${s.volume}, SL ${s.slPct}%${s.slUsd ? ` / $${s.slUsd}` : ""}${s.tpPct || s.tpUsd ? `, TP ${s.tpPct || 0}%${s.tpUsd ? ` / $${s.tpUsd}` : ""}` : ""}, hold≤${s.holdTicks}, entry=${s.entryMode}${s.entryMode === "trend" ? `, ${s.trend.timeframeHours}h EMA${s.trend.emaFast}/${s.trend.emaSlow}/${s.trend.emaTrend} risk ${s.trend.riskPct}%` : ""})`,
        meta: {
          action: "start",
          slPct: s.slPct,
          slUsd: s.slUsd,
          tpPct: s.tpPct,
          tpUsd: s.tpUsd,
          holdTicks: s.holdTicks,
          entryMode: s.entryMode,
        },
      });
    }
  }
  return getStrategyState();
}

export type TickResult = {
  state: StrategyConfig;
  action: "noop" | "open" | "close" | "skipped" | "error" | "rate_limited";
  detail?: string;
  reason?: CloseReason;
  retryAfterSec?: number;
  /** Robot log lines for this tick (trend mode); the UI persists them. */
  logs?: TickLog[];
};

function numField(obj: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const v = obj[key];
    if (v == null || v === "") continue;
    const n = typeof v === "number" ? v : Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function pickEntrySide(s: StrategyConfig): "buy" | "sell" {
  if (s.entryMode === "fixed") return s.side;
  if (s.entryMode === "random") {
    return Math.random() < 0.5 ? "buy" : "sell";
  }
  // alternate: flip from last managed/opened side, else from configured side
  const last = s.managedSide ?? s.side;
  return last === "buy" ? "sell" : "buy";
}

function evaluateExit(opts: {
  side: "buy" | "sell";
  openPrice: number | null;
  currentPrice: number | null;
  profit: number | null;
  slPct: number;
  slUsd: number;
  tpPct: number;
  tpUsd: number;
  ticksSinceOpen: number;
  holdTicks: number;
}): CloseReason | null {
  const {
    side,
    openPrice,
    currentPrice,
    profit,
    slPct,
    slUsd,
    tpPct,
    tpUsd,
    ticksSinceOpen,
    holdTicks,
  } = opts;

  if (slUsd > 0 && profit != null && profit <= -slUsd) return "sl";
  if (tpUsd > 0 && profit != null && profit >= tpUsd) return "tp";

  if (openPrice != null && openPrice > 0 && currentPrice != null) {
    const movePct =
      side === "buy"
        ? ((currentPrice - openPrice) / openPrice) * 100
        : ((openPrice - currentPrice) / openPrice) * 100;
    if (slPct > 0 && movePct <= -slPct) return "sl";
    if (tpPct > 0 && movePct >= tpPct) return "tp";
  }

  if (ticksSinceOpen >= holdTicks) return "timeout";
  return null;
}

async function closeManaged(
  client: ExnessTraderClient,
  settings: Settings,
  s: StrategyConfig,
  reason: CloseReason,
  extra?: { profit?: number | null; currentPrice?: number | null },
): Promise<TickResult> {
  const pid = s.managedPositionId!;
  s.status = "closing";
  s.lastAction = `closing:${reason}`;

  const closeAck = await client.closePosition(pid);
  const closeOp = String(closeAck.operation_id ?? "");
  if (closeOp) {
    await client.waitForOperation(closeOp, {
      timeoutSec: Math.min(settings.pollTimeoutSec, 45),
    });
  }

  const reasonLabel =
    reason === "sl" ? "stop loss" : reason === "tp" ? "take profit" : reason;
  pushMovement({
    kind: "close",
    instrument: s.instrument,
    side: s.managedSide ?? undefined,
    positionId: pid,
    operationId: closeOp || undefined,
    pnl: extra?.profit ?? null,
    message: `Robot cerró (${reason}) ${pid} — ${reasonLabel}`,
    reason,
    meta: {
      reason,
      openPrice: s.openPrice,
      currentPrice: extra?.currentPrice ?? null,
      ticksHeld: s.ticksSinceOpen,
    },
  });

  s.managedPositionId = null;
  s.managedSide = null;
  s.openPrice = null;
  s.ticksSinceOpen = 0;
  s.lastError = null;
  s.lastCloseReason = reason;
  s.lastAction = `close:${reason}`;
  s.status = "flat";
  // Alternate: next side already implied by managedSide flip on next open
  return {
    state: getStrategyState(),
    action: "close",
    detail: pid,
    reason,
  };
}

/** One step on the in-memory state (UI hydrates it before each tick). */
export async function runStrategyTick(
  client: ExnessTraderClient,
  settings: Settings,
  deps?: TrendTickDeps,
): Promise<TickResult> {
  return tickStrategy(client, settings, store().state, deps);
}

/**
 * One robot step over an explicit state object (mutated in place; the result
 * carries a snapshot). No browser dependency: callable from a cron / worker
 * that persists `state` between invocations.
 */
export async function tickStrategy(
  client: ExnessTraderClient,
  settings: Settings,
  s: StrategyConfig,
  deps?: TrendTickDeps,
): Promise<TickResult> {
  const getStrategyState = () => snapshotState(s);
  s.lastTickAt = new Date().toISOString();
  s.tickCount += 1;

  if (!s.running) {
    return { state: getStrategyState(), action: "skipped", detail: "stopped" };
  }

  try {
    if (s.entryMode === "trend") {
      const r = await tickTrend(client, settings, s, deps);
      if (r.action === "error") {
        pushMovement({
          kind: "error",
          instrument: s.instrument,
          message: `Tick error: ${r.detail ?? "?"}`,
        });
      }
      return {
        state: getStrategyState(),
        action: r.action,
        detail: r.detail,
        reason: r.reason,
        logs: r.logs,
      };
    }

    const snapshot = await client.getSnapshot();
    const positions = client.extractPositions(snapshot);

    // Reconcile managed id against live book
    if (s.managedPositionId) {
      const still = positions.find(
        (p) => positionId(p) === s.managedPositionId,
      );
      if (!still) {
        pushMovement({
          kind: "info",
          instrument: s.instrument,
          positionId: s.managedPositionId,
          message: `Posición gestionada ${s.managedPositionId} ya no está abierta (cerrada fuera del robot)`,
          meta: { action: "reconcile_flat" },
        });
        s.managedPositionId = null;
        s.managedSide = null;
        s.openPrice = null;
        s.ticksSinceOpen = 0;
        s.status = "flat";
        s.lastAction = "reconcile_flat";
      }
    }

    if (!s.managedPositionId && s.pendingBefore) {
      const known = new Set(s.pendingBefore);
      const adopted = positions.find((p) => {
        const pid = positionId(p);
        return (
          pid &&
          !known.has(pid) &&
          String(p.instrument ?? "").toUpperCase() === s.instrument
        );
      }) as Record<string, unknown> | undefined;
      s.pendingBefore = null;
      if (adopted) {
        const pid = positionId(adopted)!;
        const sideRaw = String(adopted.side ?? "").toLowerCase();
        s.managedPositionId = pid;
        s.managedSide =
          sideRaw === "buy" || sideRaw === "sell" ? sideRaw : s.side;
        s.openPrice = numField(adopted, ["open_price", "price", "avg_price"]);
        s.ticksSinceOpen = 0;
        s.status = "in_position";
        s.lastAction = `adopt:${s.managedSide}`;
        pushMovement({
          kind: "info",
          instrument: s.instrument,
          positionId: pid,
          message: `Robot adoptó posición ${pid} (open previo sin confirmar)`,
          meta: { action: "adopt" },
        });
        return { state: getStrategyState(), action: "open", detail: pid };
      }
    }

    if (!s.managedPositionId) {
      s.status = "opening";
      const entrySide = pickEntrySide(s);
      s.side = entrySide;
      s.lastAction = `opening:${entrySide}`;

      s.pendingBefore = positions
        .map((p) => positionId(p))
        .filter(Boolean) as string[];

      const ack = await client.openPosition({
        instrument: s.instrument,
        side: entrySide,
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
          s.status = "flat";
          s.lastAction = "open_error";
          s.pendingBefore = null;
          pushMovement({
            kind: "error",
            instrument: s.instrument,
            side: entrySide,
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

      const before = new Set(
        positions.map((p) => positionId(p)).filter(Boolean) as string[],
      );
      let openedId: string | null = null;
      let openedPos: Record<string, unknown> | null = null;
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const snap2 = await client.getSnapshot();
        const pos2 = client.extractPositions(snap2);
        for (const p of pos2) {
          const pid = positionId(p);
          if (!pid) continue;
          const matchNew = !before.has(pid);
          const matchEmpty =
            before.size === 0 &&
            String(p.instrument ?? "").toUpperCase() === s.instrument;
          if (matchNew || matchEmpty) {
            openedId = pid;
            openedPos = p;
            break;
          }
        }
        if (openedId) break;
        await new Promise((r) => setTimeout(r, 1500));
      }

      const openPx = openedPos
        ? numField(openedPos, ["open_price", "price", "avg_price"])
        : null;

      s.pendingBefore = openedId ? null : s.pendingBefore;
      s.managedPositionId = openedId;
      s.managedSide = entrySide;
      s.openPrice = openPx;
      s.ticksSinceOpen = 0;
      s.lastError = null;
      s.lastCloseReason = null;
      s.lastAction = openedId ? `open:${entrySide}` : "open_pending";
      s.status = openedId ? "in_position" : "flat";

      pushMovement({
        kind: "open",
        instrument: s.instrument,
        side: entrySide,
        volume: s.volume,
        positionId: openedId ?? undefined,
        operationId: operationId || undefined,
        message: openedId
          ? `Robot abrió ${entrySide} ${s.volume} ${s.instrument} @ ${openPx ?? "?"}`
          : `Robot envió open ${entrySide} (posición aún no en snapshot)`,
        meta: {
          action: "open",
          entryMode: s.entryMode,
          openPrice: openPx,
        },
      });
      return {
        state: getStrategyState(),
        action: "open",
        detail: openedId ?? "pending",
      };
    }

    // In position — monitor SL / TP / timeout
    s.ticksSinceOpen += 1;
    s.status = "in_position";

    const live = positions.find(
      (p) => positionId(p) === s.managedPositionId,
    ) as Record<string, unknown> | undefined;

    const currentPrice = live
      ? numField(live, ["current_price", "mark_price", "price"])
      : null;
    const profit = live
      ? numField(live, ["profit", "unrealized_pnl", "pnl"])
      : null;
    if (live) {
      const px = numField(live, ["open_price", "price", "avg_price"]);
      if (px != null) s.openPrice = px;
      const sideRaw = String(live.side ?? s.managedSide ?? "").toLowerCase();
      if (sideRaw === "buy" || sideRaw === "sell") s.managedSide = sideRaw;
    }

    const reason = evaluateExit({
      side: s.managedSide ?? s.side,
      openPrice: s.openPrice,
      currentPrice,
      profit,
      slPct: s.slPct,
      slUsd: s.slUsd,
      tpPct: s.tpPct,
      tpUsd: s.tpUsd,
      ticksSinceOpen: s.ticksSinceOpen,
      holdTicks: s.holdTicks,
    });

    if (!reason) {
      s.lastAction = `holding:${s.ticksSinceOpen}/${s.holdTicks}`;
      return {
        state: getStrategyState(),
        action: "noop",
        detail: `holding ${s.ticksSinceOpen}/${s.holdTicks} pnl=${profit ?? "?"}`,
      };
    }

    return await closeManaged(client, settings, s, reason, {
      profit,
      currentPrice,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    s.status = s.managedPositionId ? "in_position" : "flat";
    if (err instanceof ExnessApiError && err.statusCode === 429) {
      s.lastAction = "rate_limit";
      return {
        state: getStrategyState(),
        action: "rate_limited",
        detail: msg,
        retryAfterSec: err.retryAfterSec ?? 60,
      };
    }
    s.lastError = msg;
    s.lastAction = "error";
    pushMovement({
      kind: "error",
      instrument: s.instrument,
      message: `Tick error: ${msg}`,
    });
    return { state: getStrategyState(), action: "error", detail: msg };
  }
}
