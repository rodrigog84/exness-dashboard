/**
 * Backtest + walk-forward for the trend robot.
 *
 *   npx tsx scripts/backtest.ts                 # 3y, 1h and 4h, spread $20
 *   npx tsx scripts/backtest.ts --years 2 --tf 1 --spread 30 --commission 0.005
 *   npx tsx scripts/backtest.ts --refresh       # ignore the local candle cache
 *
 * Candles come from Bitstamp BTC/USD (keyless, reachable from servers; Binance
 * answers 451 in some regions). The trading logic is NOT re-implemented here:
 * signals, sizing, SL/TP/trailing, cooldown, daily-loss pause and spread filter
 * are the very functions in lib/trend/engine.ts that the live tick uses.
 * Only the loop that feeds candles to them differs.
 */

import fs from "node:fs";
import path from "node:path";
import { fetchBitstampHistory } from "../lib/trend/candles";
import {
  HOUR_MS,
  computeSeries,
  cooldownUntilAfterLoss,
  crossedAgainst,
  entryBlocker,
  planEntry,
  positionFromPlan,
  signalAt,
  spreadBlocker,
  stepPosition,
  timeframeMs,
  updateDay,
  type Candle,
  type DayState,
  type EntryPlan,
  type Series,
} from "../lib/trend/engine";
import {
  DEFAULT_LIMITS,
  DEFAULT_TREND,
  type InstrumentLimits,
  type TrendParams,
  type TrendPos,
} from "../lib/trend/params";

/* ---------------------------------------------------------------- options */

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) {
    return process.argv[i + 1];
  }
  return fallback;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const YEARS = Number(arg("years", "3"));
const SPREAD_USD = Number(arg("spread", "20"));
const COMMISSION_PCT = Number(arg("commission", "0"));
const EQUITY0 = Number(arg("equity", "10000"));
const TFS: Array<1 | 4> =
  arg("tf") === "1" ? [1] : arg("tf") === "4" ? [4] : [1, 4];
const REFRESH = flag("refresh");
const SPLIT = Number(arg("split", "0.6667"));

/** Spread filter off by default: a fixed $ spread is a large % of price in 2022-23 (BTC 16-20k) and would silently skip those years. */
const BT_DEFAULT: TrendParams = {
  ...DEFAULT_TREND,
  maxSpreadPct: Number(arg("max-spread-pct", "0")),
};

const LIMITS: InstrumentLimits = {
  ...DEFAULT_LIMITS,
  volumeMin: 0.001,
  volumeStep: 0.001,
  assumed: false,
};

/* ------------------------------------------------------------------- data */

const CACHE_DIR = path.join(__dirname, ".cache");

async function loadCandles(tfh: 1 | 4): Promise<Candle[]> {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const file = path.join(CACHE_DIR, `bitstamp-btcusd-${tfh}h-${YEARS}y.json`);
  if (!REFRESH && fs.existsSync(file)) {
    const st = fs.statSync(file);
    if (Date.now() - st.mtimeMs < 12 * HOUR_MS) {
      return JSON.parse(fs.readFileSync(file, "utf8")) as Candle[];
    }
  }
  const tf = tfh * HOUR_MS;
  const now = Math.floor(Date.now() / tf) * tf; // only closed candles
  const from = now - YEARS * 365 * 24 * HOUR_MS;
  process.stderr.write(`Descargando Bitstamp BTC/USD ${tfh}h (${YEARS}y)…\n`);
  const candles = await fetchBitstampHistory("BTCUSD", tfh, from, now, (n) =>
    process.stderr.write(`\r  ${n} velas`),
  );
  process.stderr.write("\n");
  fs.writeFileSync(file, JSON.stringify(candles));
  return candles;
}

function dataSummary(c: Candle[], tfh: number): string {
  const tf = tfh * HOUR_MS;
  let gaps = 0;
  for (let i = 1; i < c.length; i++) if (c[i].t - c[i - 1].t > tf) gaps++;
  const a = new Date(c[0].t).toISOString().slice(0, 10);
  const b = new Date(c[c.length - 1].t).toISOString().slice(0, 10);
  return `${c.length} velas ${tfh}h, ${a} → ${b}, huecos: ${gaps}, BTC ${c[0].o.toFixed(0)} → ${c[c.length - 1].c.toFixed(0)}`;
}

/* ------------------------------------------------------------- simulation */

type Trade = {
  entryT: number;
  exitT: number;
  side: "buy" | "sell";
  entry: number;
  exit: number;
  vol: number;
  pnl: number;
  r: number;
  reason: string;
};

type SimResult = {
  trades: Trade[];
  /** Equity per bar close relative to the starting equity (starts at 1). */
  curve: number[];
};

type SimOpts = {
  from: number;
  to: number;
  equity0: number;
  spreadUsd: number;
  commissionPct: number;
};

function simulate(
  candles: Candle[],
  s: Series,
  p: TrendParams,
  o: SimOpts,
): SimResult {
  const tf = timeframeMs(p);
  const contract = LIMITS.contractSize;
  let equity = o.equity0;
  let lastEq = equity;
  let pos: TrendPos | null = null;
  let entryT = 0;
  let pending: { plan: EntryPlan; atr: number; candleT: number } | null = null;
  let day: DayState = {
    dayKey: null,
    startEquity: null,
    paused: false,
    pnl: null,
    pnlPct: null,
  };
  let cooldownUntil = 0;
  const trades: Trade[] = [];
  const curve: number[] = [1];

  const close = (price: number, reason: string, bar: Candle, exitTime: number) => {
    const dir = pos!.side === "buy" ? 1 : -1;
    const gross = dir * (price - pos!.entry) * pos!.vol * contract;
    const spreadCost = o.spreadUsd * pos!.vol * contract;
    const comm =
      (o.commissionPct / 100) * (pos!.entry + price) * pos!.vol * contract;
    const pnl = gross - spreadCost - comm;
    equity += pnl;
    trades.push({
      entryT,
      exitT: bar.t,
      side: pos!.side,
      entry: pos!.entry,
      exit: price,
      vol: pos!.vol,
      pnl,
      r: pnl / pos!.riskUsd,
      reason,
    });
    if (pnl < 0) cooldownUntil = cooldownUntilAfterLoss(exitTime, p);
    pos = null;
  };

  const mtm = (price: number) =>
    pos
      ? equity +
        (pos.side === "buy" ? 1 : -1) * (price - pos.entry) * pos.vol * contract
      : equity;

  for (let i = o.from; i < o.to; i++) {
    const bar = candles[i];

    if (pending) {
      const fill = bar.o;
      pos = positionFromPlan(pending.plan, fill, pending.atr, pending.candleT, p);
      entryT = bar.t;
      pending = null;
    }

    day = updateDay(day, bar.t, lastEq, p);

    if (pos) {
      const ex = stepPosition(pos, { o: bar.o, h: bar.h, l: bar.l }, p);
      if (ex) close(ex.price, ex.reason, bar, bar.t);
    }

    const sig = signalAt(candles, s, i);
    if (pos && crossedAgainst(candles, s, pos.side, pos.entryCandleTime, i)) {
      close(bar.c, "cross", bar, bar.t + tf);
    }

    const eq = mtm(bar.c);
    day = updateDay(day, bar.t, eq, p);

    if (!pos && sig && i + 1 < o.to) {
      const blocked =
        entryBlocker({
          candleTime: bar.t,
          dayPaused: day.paused,
          cooldownUntil,
        }) ?? spreadBlocker(o.spreadUsd, bar.c, p);
      if (!blocked) {
        const plan = planEntry({
          side: sig,
          ref: bar.c,
          atr: s.atr[i],
          equity,
          p,
          limits: LIMITS,
        });
        if (plan.ok) pending = { plan: plan.plan, atr: s.atr[i], candleT: bar.t };
      }
    }

    lastEq = eq;
    curve.push(eq / o.equity0);
  }
  if (pos) {
    const last = candles[o.to - 1];
    close(last.c, "end", last, last.t + tf);
    curve[curve.length - 1] = equity / o.equity0;
  }
  return { trades, curve };
}

/* ---------------------------------------------------------------- metrics */

type Metrics = {
  n: number;
  winRate: number;
  avgR: number;
  pf: number;
  maxDD: number;
  ret: number;
};

function maxDrawdownPct(curve: number[]): number {
  let peak = curve[0];
  let dd = 0;
  for (const v of curve) {
    peak = Math.max(peak, v);
    dd = Math.max(dd, (peak - v) / peak);
  }
  return dd * 100;
}

function metrics(trades: Trade[], curve: number[]): Metrics {
  const n = trades.length;
  const wins = trades.filter((t) => t.pnl > 0);
  const grossW = wins.reduce((a, t) => a + t.pnl, 0);
  const grossL = trades.filter((t) => t.pnl < 0).reduce((a, t) => a + t.pnl, 0);
  return {
    n,
    winRate: n ? (wins.length / n) * 100 : 0,
    avgR: n ? trades.reduce((a, t) => a + t.r, 0) / n : 0,
    pf: grossL < 0 ? grossW / -grossL : grossW > 0 ? Infinity : 0,
    maxDD: maxDrawdownPct(curve),
    ret: (curve[curve.length - 1] - 1) * 100,
  };
}

function fmtM(m: Metrics): string {
  const pf = Number.isFinite(m.pf) ? m.pf.toFixed(2) : "inf";
  return `n=${String(m.n).padStart(3)}  win=${m.winRate.toFixed(1).padStart(5)}%  avgR=${m.avgR.toFixed(2).padStart(5)}  PF=${pf.padStart(5)}  maxDD=${m.maxDD.toFixed(1).padStart(5)}%  ret=${m.ret.toFixed(1).padStart(7)}%`;
}

function mdRow(label: string, m: Metrics): string {
  const pf = Number.isFinite(m.pf) ? m.pf.toFixed(2) : "inf";
  return `| ${label} | ${m.n} | ${m.winRate.toFixed(1)}% | ${m.avgR.toFixed(2)} | ${pf} | ${m.maxDD.toFixed(1)}% | ${m.ret.toFixed(1)}% |`;
}
const MD_HEAD =
  "| Tramo | Ops | Win rate | R prom. | Profit factor | Max DD | Retorno |\n|---|---|---|---|---|---|---|";

/* ------------------------------------------------------------------ grid */

type Combo = TrendParams;

function paramLabel(p: TrendParams): string {
  return `EMA ${p.emaFast}/${p.emaSlow}/${p.emaTrend} SL ${p.slAtrMult}xATR TP ${p.tpR || "off"}R${p.trailing ? " +trail" : ""}`;
}

function buildGrid(tfh: 1 | 4): Combo[] {
  const out: Combo[] = [];
  for (const emaFast of [10, 20, 30])
    for (const emaSlow of [50, 100])
      for (const emaTrend of [100, 200])
        for (const slAtrMult of [1.5, 2, 3])
          for (const tpR of [2, 3, 0])
            for (const trailing of [false, true]) {
              if (tpR === 0 && !trailing) continue; // added once below
              out.push({
                ...BT_DEFAULT,
                timeframeHours: tfh,
                emaFast,
                emaSlow,
                emaTrend,
                slAtrMult,
                tpR,
                trailing,
              });
            }
  // no TP and no trailing: exit only by SL or opposite cross
  for (const emaFast of [10, 20, 30])
    for (const emaSlow of [50, 100])
      for (const emaTrend of [100, 200])
        for (const slAtrMult of [1.5, 2, 3])
          out.push({
            ...BT_DEFAULT,
            timeframeHours: tfh,
            emaFast,
            emaSlow,
            emaTrend,
            slAtrMult,
            tpR: 0,
            trailing: false,
          });
  return out;
}

class SeriesCache {
  private m = new Map<string, Series>();
  constructor(private candles: Candle[]) {}
  get(p: TrendParams): Series {
    const k = `${p.emaFast}|${p.emaSlow}|${p.emaTrend}|${p.atrPeriod}`;
    let s = this.m.get(k);
    if (!s) {
      s = computeSeries(this.candles, p);
      this.m.set(k, s);
    }
    return s;
  }
}

function score(m: Metrics): number {
  if (m.n < 15) return -Infinity;
  return m.ret / Math.max(m.maxDD, 5);
}

/* ------------------------------------------------------------------- main */

function run(
  candles: Candle[],
  sc: SeriesCache,
  p: TrendParams,
  from: number,
  to: number,
  spread = SPREAD_USD,
  commission = COMMISSION_PCT,
): { m: Metrics; r: SimResult } {
  const r = simulate(candles, sc.get(p), p, {
    from,
    to,
    equity0: EQUITY0,
    spreadUsd: spread,
    commissionPct: commission,
  });
  return { m: metrics(r.trades, r.curve), r };
}

function idxAt(candles: Candle[], ms: number): number {
  let lo = 0;
  let hi = candles.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].t < ms) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

async function main() {
  console.log(
    `# Backtest tendencia BTCUSD — spread $${SPREAD_USD}/ida y vuelta, comisión ${COMMISSION_PCT}%/lado, equity inicial $${EQUITY0}\n`,
  );
  console.log(
    `Fuente: Bitstamp BTC/USD. Lógica: lib/trend/engine.ts (compartida con el robot en vivo). Riesgo ${BT_DEFAULT.riskPct}%/op, cooldown ${BT_DEFAULT.cooldownCandles} velas, pausa diaria ${BT_DEFAULT.dailyLossPct}%, filtro de spread ${BT_DEFAULT.maxSpreadPct ? BT_DEFAULT.maxSpreadPct + '%' : 'off'}.\n`,
  );

  for (const tfh of TFS) {
    const candles = await loadCandles(tfh);
    const sc = new SeriesCache(candles);
    const n = candles.length;
    const warm = 400;
    console.log(`\n## Timeframe ${tfh}h — ${dataSummary(candles, tfh)}\n`);
    const bh =
      (candles[n - 1].c / candles[warm].c - 1) * 100;
    console.log(`Buy & hold (tras warm-up): ${bh.toFixed(1)}%\n`);

    // 1. Parámetros por defecto, periodo completo y por año
    const base: TrendParams = { ...BT_DEFAULT, timeframeHours: tfh };
    console.log(`### Parámetros por defecto (${paramLabel(base)})\n`);
    console.log(MD_HEAD);
    const full = run(candles, sc, base, warm, n);
    console.log(mdRow("Periodo completo", full.m));
    const yearMs = 365 * 24 * HOUR_MS;
    const start = candles[warm].t;
    for (let y = 0; start + y * yearMs < candles[n - 1].t; y++) {
      const a = idxAt(candles, start + y * yearMs);
      const b = Math.min(n, idxAt(candles, start + (y + 1) * yearMs));
      if (b - a < 200) continue;
      const r = run(candles, sc, base, Math.max(a, warm), b);
      console.log(mdRow(`Año ${y + 1} (${new Date(candles[a].t).toISOString().slice(0, 7)})`, r.m));
    }
    const longs = full.r.trades.filter((t) => t.side === "buy");
    const shorts = full.r.trades.filter((t) => t.side === "sell");
    const sumR = (ts: Trade[]) => ts.reduce((a, t) => a + t.r, 0);
    console.log(
      `\nPor lado: compras n=${longs.length} sumR=${sumR(longs).toFixed(1)} | ventas n=${shorts.length} sumR=${sumR(shorts).toFixed(1)}`,
    );
    const byReason = new Map<string, { n: number; r: number }>();
    for (const t of full.r.trades) {
      const e = byReason.get(t.reason) ?? { n: 0, r: 0 };
      e.n++;
      e.r += t.r;
      byReason.set(t.reason, e);
    }
    console.log(
      "Por salida: " +
        [...byReason.entries()]
          .map(([k, v]) => `${k} n=${v.n} sumR=${v.r.toFixed(1)}`)
          .join(" | "),
    );

    // 2. Sensibilidad a costos
    console.log(`\n### Sensibilidad a costos (parámetros por defecto)\n`);
    console.log(MD_HEAD);
    for (const [sp, cm] of [
      [0, 0],
      [SPREAD_USD, 0],
      [50, 0],
      [SPREAD_USD, 0.01],
    ] as const) {
      const r = run(candles, sc, base, warm, n, sp, cm);
      console.log(mdRow(`spread $${sp}, comisión ${cm}%/lado`, r.m));
    }

    // 3. Grid + split fijo
    const grid = buildGrid(tfh);
    const split = warm + Math.floor((n - warm) * SPLIT);

    const variants: Array<[string, Partial<TrendParams>]> = [
      ["defaults", {}],
      ["SL 2xATR", { slAtrMult: 2 }],
      ["TP 3R", { tpR: 3 }],
      ["sin TP + trailing (act. 1R, 2xATR)", { tpR: 0, trailing: true, trailAtrMult: 2 }],
      ["TP 2R + trailing 1.5xATR", { trailing: true }],
      ["EMA 20/50/100", { emaTrend: 100 }],
      ["EMA 50/100/200", { emaFast: 50, emaSlow: 100 }],
    ];
    console.log(
      `\n### Variantes declaradas a priori (no elegidas por búsqueda): train vs validación\n`,
    );
    console.log(MD_HEAD);
    for (const [name, o] of variants) {
      const vp = { ...base, ...o };
      console.log(mdRow(`TRAIN ${name}`, run(candles, sc, vp, warm, split).m));
      console.log(mdRow(`↳ VALID ${name}`, run(candles, sc, vp, split, n).m));
    }
    console.log(
      `\n### Split fijo: entrenar en el primer ${(SPLIT * 100).toFixed(0)}% (${new Date(candles[warm].t).toISOString().slice(0, 10)} → ${new Date(candles[split].t).toISOString().slice(0, 10)}), validar en el resto sin reajustar (${grid.length} combinaciones)\n`,
    );
    const trainRes = grid.map((p) => ({ p, ...run(candles, sc, p, warm, split) }));
    trainRes.sort((a, b) => score(b.m) - score(a.m));
    console.log(MD_HEAD);
    const top = trainRes.slice(0, 5);
    for (const t of top) {
      console.log(mdRow(`TRAIN ${paramLabel(t.p)}`, t.m));
      const v = run(candles, sc, t.p, split, n);
      console.log(mdRow(`↳ VALID`, v.m));
    }
    const dTrain = run(candles, sc, base, warm, split);
    const dValid = run(candles, sc, base, split, n);
    console.log(mdRow(`TRAIN defaults`, dTrain.m));
    console.log(mdRow(`↳ VALID defaults`, dValid.m));
    const posTrain = trainRes.filter((t) => t.m.n >= 15 && t.m.pf > 1).length;
    const posValid = trainRes.filter((t) => {
      if (!(t.m.n >= 15 && t.m.pf > 1)) return false;
      return run(candles, sc, t.p, split, n).m.pf > 1;
    }).length;
    console.log(
      `\nDe ${posTrain} combinaciones con PF>1 en train, ${posValid} mantienen PF>1 en validación.`,
    );

    // 4. Walk-forward rodante: entrenar 12m, probar 3m, avanzar 3m
    const trainMs = 365 * 24 * HOUR_MS;
    const testMs = 91 * 24 * HOUR_MS;
    console.log(
      `\n### Walk-forward rodante (train 12m → test 3m, sin reajustar dentro del test)\n`,
    );
    const oosTrades: Trade[] = [];
    let oosCurve: number[] = [1];
    const baseCurve: number[] = [1];
    const baseTrades: Trade[] = [];
    let foldNo = 0;
    const rows: string[] = [];
    for (let t0 = candles[warm].t; ; t0 += testMs) {
      const a = idxAt(candles, t0);
      const b = idxAt(candles, t0 + trainMs);
      const c = Math.min(n, idxAt(candles, t0 + trainMs + testMs));
      if (c - b < 200 || b - a < 1000) break;
      const ranked = grid
        .map((p) => ({ p, ...run(candles, sc, p, a, b) }))
        .sort((x, y) => score(y.m) - score(x.m));
      const best = ranked[0];
      const test = run(candles, sc, best.p, b, c);
      const dtest = run(candles, sc, base, b, c);
      foldNo++;
      oosTrades.push(...test.r.trades);
      const last = oosCurve[oosCurve.length - 1];
      for (const v of test.r.curve.slice(1)) oosCurve.push(last * v);
      baseTrades.push(...dtest.r.trades);
      const lb = baseCurve[baseCurve.length - 1];
      for (const v of dtest.r.curve.slice(1)) baseCurve.push(lb * v);
      rows.push(
        `| ${foldNo} | ${new Date(candles[b].t).toISOString().slice(0, 7)} | ${paramLabel(best.p)} | PF ${Number.isFinite(best.m.pf) ? best.m.pf.toFixed(2) : "inf"} / ${best.m.ret.toFixed(0)}% | n=${test.m.n} PF ${Number.isFinite(test.m.pf) ? test.m.pf.toFixed(2) : "inf"} ret ${test.m.ret.toFixed(1)}% | PF ${Number.isFinite(dtest.m.pf) ? dtest.m.pf.toFixed(2) : "inf"} ret ${dtest.m.ret.toFixed(1)}% |`,
      );
    }
    console.log(
      "| Fold | Inicio test | Mejor params (train) | Train | TEST (params elegidos) | TEST (defaults) |\n|---|---|---|---|---|---|",
    );
    rows.forEach((r) => console.log(r));
    console.log(`\n${MD_HEAD}`);
    console.log(mdRow("OOS agregado (params elegidos por fold)", metrics(oosTrades, oosCurve)));
    console.log(mdRow("OOS agregado (defaults fijos)", metrics(baseTrades, baseCurve)));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
