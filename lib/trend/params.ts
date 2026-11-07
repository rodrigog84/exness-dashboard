/**
 * Trend-following parameters + runtime state types.
 * Pure (no Node / server imports): shared by the server tick, the browser UI
 * and the backtest script.
 */

export type CandleSource =
  | "auto"
  | "exness"
  | "kraken"
  | "bitstamp"
  | "coinbase";

export const CANDLE_SOURCES: CandleSource[] = [
  "auto",
  "exness",
  "kraken",
  "bitstamp",
  "coinbase",
];

export type CloseReason =
  | "sl"
  | "tp"
  | "timeout"
  | "trail"
  | "cross"
  | "broker";

export type TrendParams = {
  /** Candle timeframe in hours (1 or 4). */
  timeframeHours: 1 | 4;
  emaFast: number;
  emaSlow: number;
  emaTrend: number;
  atrPeriod: number;
  /** SL distance = slAtrMult × ATR from entry. */
  slAtrMult: number;
  /** Take profit at tpR × initial risk. 0 = off. */
  tpR: number;
  trailing: boolean;
  /** Trailing starts once the open profit reaches this many R. */
  trailActivateR: number;
  /** Trailing distance = trailAtrMult × ATR(entry), measured from the best price. */
  trailAtrMult: number;
  /** Risk per trade in % of equity. */
  riskPct: number;
  /** Hard cap for the computed volume (lots). */
  maxVolume: number;
  /** Do not enter when spread > this % of price. 0 = off. */
  maxSpreadPct: number;
  /** Candles to skip after each losing trade. */
  cooldownCandles: number;
  /** Pause new entries for the UTC day when equity is down this %. */
  dailyLossPct: number;
  candleSource: CandleSource;
};

export const DEFAULT_TREND: TrendParams = {
  timeframeHours: 1,
  emaFast: 20,
  emaSlow: 50,
  emaTrend: 200,
  atrPeriod: 14,
  slAtrMult: 1.5,
  tpR: 2,
  trailing: false,
  trailActivateR: 1,
  trailAtrMult: 1.5,
  riskPct: 0.5,
  maxVolume: 0.5,
  maxSpreadPct: 0.05,
  cooldownCandles: 3,
  dailyLossPct: 3,
  candleSource: "auto",
};

export type InstrumentLimits = {
  volumeMin: number;
  volumeMax: number;
  volumeStep: number;
  pointDigits: number;
  contractSize: number;
  at: number;
  /** true when the API did not answer and defaults were assumed. */
  assumed: boolean;
};

export const DEFAULT_LIMITS: InstrumentLimits = {
  volumeMin: 0.01,
  volumeMax: 100,
  volumeStep: 0.01,
  pointDigits: 2,
  contractSize: 1,
  at: 0,
  assumed: true,
};

export type IndicatorSnapshot = {
  /** Open time (ms) of the evaluated closed candle. */
  t: number;
  close: number;
  emaFast: number;
  emaSlow: number;
  emaTrend: number;
  atr: number;
  source: string;
};

export type SignalInfo = {
  at: string;
  candleTime: number;
  side: "buy" | "sell" | null;
  note: string;
};

/** Open trend position (levels are managed by the robot and, when accepted, by the broker). */
export type TrendPos = {
  side: "buy" | "sell";
  entry: number;
  sl: number;
  tp: number | null;
  vol: number;
  /** ATR at entry (used for trailing distance). */
  atr: number;
  /** Initial |entry − sl| (1R in price units). */
  riskDist: number;
  /** Planned $ risk (1R). */
  riskUsd: number;
  entryCandleTime: number;
  best: number;
  trailActive: boolean;
};

export type TrendRuntimePos = TrendPos & {
  equityAtOpen: number | null;
  /** SL/TP also sent to the broker with the open order. */
  brokerStops: boolean;
  lastPrice: number | null;
  lastProfit: number | null;
};

export type PendingOpen = {
  pos: TrendPos;
  equityAtOpen: number | null;
  brokerStops: boolean;
};

export type TrendRuntime = {
  lastCandleTime: number | null;
  indicators: IndicatorSnapshot | null;
  lastSignal: SignalInfo | null;
  nextEvalAt: number | null;
  equity: number | null;
  dayKey: string | null;
  dayStartEquity: number | null;
  dayPnl: number | null;
  dayPnlPct: number | null;
  dayPaused: boolean;
  /** Entries are blocked for candles with open time < cooldownUntil (ms). */
  cooldownUntil: number;
  lastSpread: number | null;
  lastSpreadPct: number | null;
  /** $ risk of the last planned trade. */
  riskUsd: number | null;
  limits: InstrumentLimits | null;
  pos: TrendRuntimePos | null;
  pendingOpen: PendingOpen | null;
};

export function defaultRuntime(): TrendRuntime {
  return {
    lastCandleTime: null,
    indicators: null,
    lastSignal: null,
    nextEvalAt: null,
    equity: null,
    dayKey: null,
    dayStartEquity: null,
    dayPnl: null,
    dayPnlPct: null,
    dayPaused: false,
    cooldownUntil: 0,
    lastSpread: null,
    lastSpreadPct: null,
    riskUsd: null,
    limits: null,
    pos: null,
    pendingOpen: null,
  };
}

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function clampNum(
  v: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  const n = num(v);
  if (n == null) return fallback;
  return Math.min(max, Math.max(min, n));
}

function clampInt(
  v: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  return Math.round(clampNum(v, min, max, fallback));
}

/** Validate / clamp user-provided params; invalid fields fall back to `base`. */
export function sanitizeTrendParams(
  input: unknown,
  base: TrendParams = DEFAULT_TREND,
): TrendParams {
  const i =
    input && typeof input === "object"
      ? (input as Record<string, unknown>)
      : {};
  const tf = num(i.timeframeHours);
  const src = String(i.candleSource ?? "").toLowerCase() as CandleSource;
  const p: TrendParams = {
    timeframeHours: tf === 4 ? 4 : tf === 1 ? 1 : base.timeframeHours,
    emaFast: clampInt(i.emaFast, 2, 300, base.emaFast),
    emaSlow: clampInt(i.emaSlow, 3, 400, base.emaSlow),
    emaTrend: clampInt(i.emaTrend, 5, 600, base.emaTrend),
    atrPeriod: clampInt(i.atrPeriod, 2, 100, base.atrPeriod),
    slAtrMult: clampNum(i.slAtrMult, 0.3, 10, base.slAtrMult),
    tpR: clampNum(i.tpR, 0, 10, base.tpR),
    trailing: typeof i.trailing === "boolean" ? i.trailing : base.trailing,
    trailActivateR: clampNum(i.trailActivateR, 0, 10, base.trailActivateR),
    trailAtrMult: clampNum(i.trailAtrMult, 0.3, 10, base.trailAtrMult),
    riskPct: clampNum(i.riskPct, 0.05, 2, base.riskPct),
    maxVolume: clampNum(i.maxVolume, 0.001, 1000, base.maxVolume),
    maxSpreadPct: clampNum(i.maxSpreadPct, 0, 5, base.maxSpreadPct),
    cooldownCandles: clampInt(i.cooldownCandles, 0, 48, base.cooldownCandles),
    dailyLossPct: clampNum(i.dailyLossPct, 0.5, 20, base.dailyLossPct),
    candleSource: CANDLE_SOURCES.includes(src) ? src : base.candleSource,
  };
  if (!(p.emaFast < p.emaSlow && p.emaSlow < p.emaTrend)) {
    p.emaFast = base.emaFast;
    p.emaSlow = base.emaSlow;
    p.emaTrend = base.emaTrend;
  }
  return p;
}

function sanitizePosBase(i: Record<string, unknown>): TrendPos | null {
  const side = i.side === "buy" || i.side === "sell" ? i.side : null;
  const entry = num(i.entry);
  const sl = num(i.sl);
  const vol = num(i.vol);
  const atr = num(i.atr);
  const riskDist = num(i.riskDist);
  const riskUsd = num(i.riskUsd);
  const ect = num(i.entryCandleTime);
  if (
    !side ||
    entry == null ||
    sl == null ||
    vol == null ||
    atr == null ||
    riskDist == null ||
    riskUsd == null ||
    ect == null
  ) {
    return null;
  }
  return {
    side,
    entry,
    sl,
    tp: num(i.tp),
    vol,
    atr,
    riskDist,
    riskUsd,
    entryCandleTime: ect,
    best: num(i.best) ?? entry,
    trailActive: i.trailActive === true,
  };
}

function sanitizeLimits(v: unknown): InstrumentLimits | null {
  if (!v || typeof v !== "object") return null;
  const i = v as Record<string, unknown>;
  const volumeMin = num(i.volumeMin);
  const volumeMax = num(i.volumeMax);
  const volumeStep = num(i.volumeStep);
  if (volumeMin == null || volumeMax == null || volumeStep == null) return null;
  if (volumeMin <= 0 || volumeStep <= 0 || volumeMax < volumeMin) return null;
  return {
    volumeMin,
    volumeMax,
    volumeStep,
    pointDigits: clampInt(i.pointDigits, 0, 10, 2),
    contractSize: clampNum(i.contractSize, 1e-9, 1e9, 1),
    at: num(i.at) ?? 0,
    assumed: i.assumed === true,
  };
}

/** Validate the runtime state the browser sends back with every tick. */
export function sanitizeRuntime(input: unknown): TrendRuntime {
  const base = defaultRuntime();
  if (!input || typeof input !== "object") return base;
  const i = input as Record<string, unknown>;

  let indicators: IndicatorSnapshot | null = null;
  if (i.indicators && typeof i.indicators === "object") {
    const x = i.indicators as Record<string, unknown>;
    const t = num(x.t);
    const close = num(x.close);
    const emaFast = num(x.emaFast);
    const emaSlow = num(x.emaSlow);
    const emaTrend = num(x.emaTrend);
    const atr = num(x.atr);
    if (
      t != null &&
      close != null &&
      emaFast != null &&
      emaSlow != null &&
      emaTrend != null &&
      atr != null
    ) {
      indicators = {
        t,
        close,
        emaFast,
        emaSlow,
        emaTrend,
        atr,
        source: typeof x.source === "string" ? x.source.slice(0, 40) : "?",
      };
    }
  }

  let lastSignal: SignalInfo | null = null;
  if (i.lastSignal && typeof i.lastSignal === "object") {
    const x = i.lastSignal as Record<string, unknown>;
    const candleTime = num(x.candleTime);
    if (candleTime != null && typeof x.at === "string") {
      lastSignal = {
        at: x.at,
        candleTime,
        side: x.side === "buy" || x.side === "sell" ? x.side : null,
        note: typeof x.note === "string" ? x.note.slice(0, 200) : "",
      };
    }
  }

  let pos: TrendRuntimePos | null = null;
  if (i.pos && typeof i.pos === "object") {
    const x = i.pos as Record<string, unknown>;
    const b = sanitizePosBase(x);
    if (b) {
      pos = {
        ...b,
        equityAtOpen: num(x.equityAtOpen),
        brokerStops: x.brokerStops === true,
        lastPrice: num(x.lastPrice),
        lastProfit: num(x.lastProfit),
      };
    }
  }

  let pendingOpen: PendingOpen | null = null;
  if (i.pendingOpen && typeof i.pendingOpen === "object") {
    const x = i.pendingOpen as Record<string, unknown>;
    const b =
      x.pos && typeof x.pos === "object"
        ? sanitizePosBase(x.pos as Record<string, unknown>)
        : null;
    if (b) {
      pendingOpen = {
        pos: b,
        equityAtOpen: num(x.equityAtOpen),
        brokerStops: x.brokerStops === true,
      };
    }
  }

  return {
    lastCandleTime: num(i.lastCandleTime),
    indicators,
    lastSignal,
    nextEvalAt: num(i.nextEvalAt),
    equity: num(i.equity),
    dayKey: typeof i.dayKey === "string" ? i.dayKey : null,
    dayStartEquity: num(i.dayStartEquity),
    dayPnl: num(i.dayPnl),
    dayPnlPct: num(i.dayPnlPct),
    dayPaused: i.dayPaused === true,
    cooldownUntil: num(i.cooldownUntil) ?? 0,
    lastSpread: num(i.lastSpread),
    lastSpreadPct: num(i.lastSpreadPct),
    riskUsd: num(i.riskUsd),
    limits: sanitizeLimits(i.limits),
    pos,
    pendingOpen,
  };
}
