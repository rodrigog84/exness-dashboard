/**
 * Pure trend-following engine: indicators, signals, sizing, position stepping
 * and brakes. No I/O. The live tick (lib/trend/runner.ts) and the backtest
 * (scripts/backtest.ts) both call exactly these functions.
 */

import type {
  IndicatorSnapshot,
  InstrumentLimits,
  TrendParams,
  TrendPos,
} from "./params";

export type Side = "buy" | "sell";

/** t = candle open time in ms (UTC). */
export type Candle = {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v?: number;
};

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

export function timeframeMs(p: Pick<TrendParams, "timeframeHours">): number {
  return p.timeframeHours * HOUR_MS;
}

/** EMA seeded with the SMA of the first `period` values (NaN before that). */
export function ema(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (period < 1 || values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let prev = sum / period;
  out[period - 1] = prev;
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Wilder ATR (NaN before index `period`). */
export function atr(candles: Candle[], period: number): number[] {
  const out = new Array<number>(candles.length).fill(NaN);
  if (candles.length <= period) return out;
  const tr = new Array<number>(candles.length).fill(NaN);
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const pc = candles[i - 1].c;
    tr[i] = Math.max(c.h - c.l, Math.abs(c.h - pc), Math.abs(c.l - pc));
  }
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr[i];
  let prev = sum / period;
  out[period] = prev;
  for (let i = period + 1; i < candles.length; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

export type Series = {
  fast: number[];
  slow: number[];
  trend: number[];
  atr: number[];
};

export function computeSeries(
  candles: Candle[],
  p: Pick<TrendParams, "emaFast" | "emaSlow" | "emaTrend" | "atrPeriod">,
): Series {
  const closes = candles.map((c) => c.c);
  return {
    fast: ema(closes, p.emaFast),
    slow: ema(closes, p.emaSlow),
    trend: ema(closes, p.emaTrend),
    atr: atr(candles, p.atrPeriod),
  };
}

function finite(...xs: number[]): boolean {
  return xs.every((x) => Number.isFinite(x));
}

/**
 * Signal on the close of candle i: buy when EMA fast crosses above EMA slow
 * and close > EMA trend; sell for the opposite.
 */
export function signalAt(
  candles: Candle[],
  s: Series,
  i: number,
): Side | null {
  if (i < 1 || i >= candles.length) return null;
  const f0 = s.fast[i - 1];
  const f1 = s.fast[i];
  const s0 = s.slow[i - 1];
  const s1 = s.slow[i];
  const tr = s.trend[i];
  const close = candles[i].c;
  if (!finite(f0, f1, s0, s1, tr)) return null;
  if (f0 <= s0 && f1 > s1 && close > tr) return "buy";
  if (f0 >= s0 && f1 < s1 && close < tr) return "sell";
  return null;
}

/**
 * True when an EMA cross against `side` happened on any candle after
 * `afterT` up to index i (robust to candles missed while the tab was closed).
 */
export function crossedAgainst(
  candles: Candle[],
  s: Series,
  side: Side,
  afterT: number,
  i: number,
): boolean {
  for (let k = Math.max(1, i); k >= 1 && candles[k].t > afterT; k--) {
    const f0 = s.fast[k - 1];
    const f1 = s.fast[k];
    const s0 = s.slow[k - 1];
    const s1 = s.slow[k];
    if (!finite(f0, f1, s0, s1)) break;
    if (side === "buy" && f0 >= s0 && f1 < s1) return true;
    if (side === "sell" && f0 <= s0 && f1 > s1) return true;
  }
  return false;
}

export type CloseEvaluation = {
  indicators: IndicatorSnapshot;
  signal: Side | null;
  /** Open position should be closed because the trend reversed. */
  crossExit: boolean;
};

/** Evaluate the last candle of `candles` (all closed, ascending). */
export function evaluateClose(
  candles: Candle[],
  p: TrendParams,
  pos: Pick<TrendPos, "side" | "entryCandleTime"> | null,
  source: string,
): CloseEvaluation | null {
  const i = candles.length - 1;
  if (i < 1) return null;
  const s = computeSeries(candles, p);
  const f = s.fast[i];
  const sl = s.slow[i];
  const tr = s.trend[i];
  const a = s.atr[i];
  if (!finite(f, sl, tr, a)) return null;
  return {
    indicators: {
      t: candles[i].t,
      close: candles[i].c,
      emaFast: f,
      emaSlow: sl,
      emaTrend: tr,
      atr: a,
      source,
    },
    signal: signalAt(candles, s, i),
    crossExit: pos
      ? crossedAgainst(candles, s, pos.side, pos.entryCandleTime, i)
      : false,
  };
}

/** Candles needed before indicators are meaningful. */
export function minCandles(p: TrendParams): number {
  return Math.max(p.emaTrend * 2, p.emaTrend + 100, p.atrPeriod + 2);
}

/* ---------------------------------------------------------------- sizing */

export type EntryPlan = {
  side: Side;
  sl: number;
  tp: number | null;
  volume: number;
  riskUsd: number;
  slDist: number;
};

function decimals(step: number): number {
  const s = String(step);
  if (s.includes("e-")) return Number(s.split("e-")[1]);
  const d = s.split(".")[1];
  return d ? d.length : 0;
}

export function roundToStep(v: number, step: number, mode: "floor" | "round" = "floor"): number {
  const q = v / step;
  const n = mode === "floor" ? Math.floor(q + 1e-9) : Math.round(q);
  return Number((n * step).toFixed(decimals(step)));
}

export function formatVolume(v: number, limits: Pick<InstrumentLimits, "volumeStep">): string {
  return v.toFixed(decimals(limits.volumeStep));
}

export function formatPrice(v: number, pointDigits: number): string {
  return v.toFixed(pointDigits);
}

/** volume = risk $ / (SL distance × contract size), floored to the step, capped. */
export function computeVolume(opts: {
  equity: number;
  riskPct: number;
  slDist: number;
  maxVolume: number;
  limits: InstrumentLimits;
}): { volume: number; riskUsd: number } | { error: string } {
  const { equity, riskPct, slDist, maxVolume, limits } = opts;
  if (!(equity > 0)) return { error: "equity desconocido" };
  if (!(slDist > 0)) return { error: "distancia SL inválida" };
  const riskTarget = (equity * riskPct) / 100;
  const raw = riskTarget / (slDist * limits.contractSize);
  const cap = Math.min(maxVolume, limits.volumeMax);
  let vol = roundToStep(Math.min(raw, cap), limits.volumeStep, "floor");
  if (vol < limits.volumeMin) {
    if (cap < limits.volumeMin) {
      return { error: `volumen máx. (${cap}) menor al mínimo ${limits.volumeMin}` };
    }
    return {
      error: `volumen calculado ${raw.toFixed(4)} < mínimo ${limits.volumeMin} (riesgo ${riskPct}% demasiado bajo para este equity)`,
    };
  }
  vol = Math.min(vol, cap);
  return { volume: vol, riskUsd: vol * slDist * limits.contractSize };
}

export function planEntry(opts: {
  side: Side;
  ref: number;
  atr: number;
  equity: number;
  p: TrendParams;
  limits: InstrumentLimits;
}): { ok: true; plan: EntryPlan } | { ok: false; reason: string } {
  const { side, ref, atr: a, equity, p, limits } = opts;
  const slDist = p.slAtrMult * a;
  const v = computeVolume({
    equity,
    riskPct: p.riskPct,
    slDist,
    maxVolume: p.maxVolume,
    limits,
  });
  if ("error" in v) return { ok: false, reason: v.error };
  const dir = side === "buy" ? 1 : -1;
  return {
    ok: true,
    plan: {
      side,
      sl: ref - dir * slDist,
      tp: p.tpR > 0 ? ref + dir * p.tpR * slDist : null,
      volume: v.volume,
      riskUsd: v.riskUsd,
      slDist,
    },
  };
}

/** Build the managed position from an entry plan and the actual fill price. */
export function positionFromPlan(
  plan: EntryPlan,
  fill: number,
  atrAtEntry: number,
  entryCandleTime: number,
  p: Pick<TrendParams, "tpR">,
): TrendPos {
  const dir = plan.side === "buy" ? 1 : -1;
  return {
    side: plan.side,
    entry: fill,
    sl: fill - dir * plan.slDist,
    tp: p.tpR > 0 ? fill + dir * p.tpR * plan.slDist : null,
    vol: plan.volume,
    atr: atrAtEntry,
    riskDist: plan.slDist,
    riskUsd: plan.riskUsd,
    entryCandleTime,
    best: fill,
    trailActive: false,
  };
}

/* ---------------------------------------------------------- position step */

export type PosExit = { reason: "sl" | "tp" | "trail"; price: number };

/**
 * Advance an open position over a price range. Live passes h = l = current
 * price; the backtest passes the candle's high/low (and open to model gaps).
 * When SL and TP are both inside the range SL wins (conservative).
 * Mutates `pos` (best price, trailing stop).
 */
export function stepPosition(
  pos: TrendPos,
  bar: { o?: number; h: number; l: number },
  p: Pick<TrendParams, "trailing" | "trailActivateR" | "trailAtrMult">,
): PosExit | null {
  const buy = pos.side === "buy";
  const slHit = buy ? bar.l <= pos.sl : bar.h >= pos.sl;
  if (slHit) {
    let price = pos.sl;
    if (bar.o != null) price = buy ? Math.min(pos.sl, bar.o) : Math.max(pos.sl, bar.o);
    return { reason: pos.trailActive ? "trail" : "sl", price };
  }
  if (pos.tp != null) {
    const tpHit = buy ? bar.h >= pos.tp : bar.l <= pos.tp;
    if (tpHit) {
      let price = pos.tp;
      if (bar.o != null) price = buy ? Math.max(pos.tp, bar.o) : Math.min(pos.tp, bar.o);
      return { reason: "tp", price };
    }
  }
  pos.best = buy ? Math.max(pos.best, bar.h) : Math.min(pos.best, bar.l);
  if (p.trailing) {
    const dir = buy ? 1 : -1;
    const gain = dir * (pos.best - pos.entry);
    if (gain >= p.trailActivateR * pos.riskDist) {
      const cand = pos.best - dir * p.trailAtrMult * pos.atr;
      if (dir * (cand - pos.sl) > 0) {
        pos.sl = cand;
        pos.trailActive = true;
      }
    }
  }
  return null;
}

/* ------------------------------------------------------------------ brakes */

export type DayState = {
  dayKey: string | null;
  startEquity: number | null;
  paused: boolean;
  pnl: number | null;
  pnlPct: number | null;
};

export function utcDayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Track the UTC-day PnL (equity based) and pause entries past the loss limit. */
export function updateDay(
  d: DayState,
  nowMs: number,
  equity: number | null,
  p: Pick<TrendParams, "dailyLossPct">,
): DayState {
  const key = utcDayKey(nowMs);
  let { startEquity, paused } = d;
  if (d.dayKey !== key) {
    startEquity = equity;
    paused = false;
  }
  if (startEquity == null && equity != null) startEquity = equity;
  let pnl: number | null = null;
  let pnlPct: number | null = null;
  if (equity != null && startEquity != null && startEquity > 0) {
    pnl = equity - startEquity;
    pnlPct = (pnl / startEquity) * 100;
    if (pnlPct <= -p.dailyLossPct) paused = true;
  }
  return { dayKey: key, startEquity, paused, pnl, pnlPct };
}

/** Entries are blocked for candles opened before the returned time. */
export function cooldownUntilAfterLoss(
  exitTimeMs: number,
  p: Pick<TrendParams, "timeframeHours" | "cooldownCandles">,
): number {
  const tf = timeframeMs(p);
  return Math.floor(exitTimeMs / tf) * tf + p.cooldownCandles * tf;
}

export function entryBlocker(opts: {
  candleTime: number;
  dayPaused: boolean;
  cooldownUntil: number;
}): string | null {
  if (opts.dayPaused) return "pausa del día (pérdida diaria)";
  if (opts.candleTime < opts.cooldownUntil) {
    const left = Math.max(1, Math.ceil((opts.cooldownUntil - opts.candleTime) / HOUR_MS));
    return `cooldown tras pérdida (~${left}h)`;
  }
  return null;
}

export function spreadBlocker(
  spread: number | null,
  ref: number,
  p: Pick<TrendParams, "maxSpreadPct">,
): string | null {
  if (spread == null || p.maxSpreadPct <= 0 || !(ref > 0)) return null;
  const pct = (spread / ref) * 100;
  if (pct > p.maxSpreadPct) {
    return `spread alto ${spread.toFixed(2)} (${pct.toFixed(3)}% > ${p.maxSpreadPct}%)`;
  }
  return null;
}

/** Open time of the latest closed candle at `nowMs`. */
export function latestClosedCandleTime(
  nowMs: number,
  p: Pick<TrendParams, "timeframeHours">,
): number {
  const tf = timeframeMs(p);
  return Math.floor(nowMs / tf) * tf - tf;
}

/** When the next candle closes (+ grace for the data source to publish it). */
export function nextEvalTime(
  nowMs: number,
  p: Pick<TrendParams, "timeframeHours">,
  graceMs = 8_000,
): number {
  const tf = timeframeMs(p);
  return Math.floor(nowMs / tf) * tf + tf + graceMs;
}

/** Signals older than this after the candle close are not traded (tab was closed). */
export function maxEntryDelayMs(p: Pick<TrendParams, "timeframeHours">): number {
  return timeframeMs(p) / 3;
}
