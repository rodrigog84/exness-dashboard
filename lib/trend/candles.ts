/**
 * Candle sources for the trend robot (server-side, also used by the backtest).
 *
 * 1. Exness Public Trader API: GET /v1/market-data/accounts/{id}/candles
 *    (H1/H4, bid/ask) via the account access point. Preferred: same prices as
 *    the traded instrument. Not reachable without credentials, so on any error
 *    or implausible response we fall back to:
 * 2. Public keyless REST APIs that answer from Vercel (US) datacenters:
 *    Kraken -> Bitstamp -> Coinbase. Binance is intentionally absent (HTTP 451
 *    from restricted regions).
 *
 * Candles are cached per isolate; the tick only asks for candles when a new
 * closed candle should exist, so request volume is ~1 per hour.
 */

import type { Candle } from "./engine";
import { HOUR_MS } from "./engine";
import type { CandleSource } from "./params";

export type ExnessCandleApi = {
  getCandles(opts: {
    instrument?: string;
    timeframe: string;
    priceType?: "bid" | "ask" | "both";
    from: string;
    to?: string;
    count?: number;
  }): Promise<Record<string, unknown>>;
};

export type Quote = { bid: number; ask: number };

export type CandleBatch = {
  /** Closed candles, ascending. */
  candles: Candle[];
  /** Candle in progress (when the source returns it). */
  forming: Candle | null;
  source: string;
  tried: string[];
};

export type FetchCandlesOpts = {
  instrument: string;
  timeframeHours: 1 | 4;
  source: CandleSource;
  now: number;
  /** Minimum closed candles required for the batch to be accepted. */
  minCandles: number;
  exness?: ExnessCandleApi | null;
};

const CACHE_TTL_MS = 45_000;
const REQUEST_TIMEOUT_MS = 12_000;

type CacheEntry = { at: number; key: string; batch: CandleBatch };
const g = globalThis as unknown as { __exnCandles?: Map<string, CacheEntry> };
function cache(): Map<string, CacheEntry> {
  if (!g.__exnCandles) g.__exnCandles = new Map();
  return g.__exnCandles;
}

/* ------------------------------------------------------------ public APIs */

function baseAsset(instrument: string): string | null {
  const m = /^(BTC|ETH)(USD|USDT)?[A-Z]?$/.exec(instrument.toUpperCase());
  return m ? m[1] : null;
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "exness-dashboard/1.0" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${new URL(url).hostname}`);
  return res.json();
}

function numOf(v: unknown): number {
  return typeof v === "number" ? v : Number(v);
}

export async function fetchKraken(
  instrument: string,
  tfHours: 1 | 4,
): Promise<Candle[]> {
  const base = baseAsset(instrument);
  if (!base) throw new Error(`Kraken: instrumento ${instrument} no soportado`);
  const pair = base === "BTC" ? "XBTUSD" : `${base}USD`;
  const json = (await getJson(
    `https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=${tfHours * 60}`,
  )) as { error?: string[]; result?: Record<string, unknown> };
  if (json.error?.length) throw new Error(`Kraken: ${json.error.join(",")}`);
  const key = Object.keys(json.result ?? {}).find((k) => k !== "last");
  const rows = key ? (json.result![key] as unknown[][]) : null;
  if (!Array.isArray(rows)) throw new Error("Kraken: respuesta sin velas");
  return rows.map((r) => ({
    t: numOf(r[0]) * 1000,
    o: numOf(r[1]),
    h: numOf(r[2]),
    l: numOf(r[3]),
    c: numOf(r[4]),
    v: numOf(r[6]),
  }));
}

type BitstampRow = {
  timestamp: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
};

function bitstampRows(json: unknown): Candle[] {
  const rows = (json as { data?: { ohlc?: BitstampRow[] } })?.data?.ohlc;
  if (!Array.isArray(rows)) throw new Error("Bitstamp: respuesta sin velas");
  return rows.map((r) => ({
    t: numOf(r.timestamp) * 1000,
    o: numOf(r.open),
    h: numOf(r.high),
    l: numOf(r.low),
    c: numOf(r.close),
    v: numOf(r.volume),
  }));
}

export async function fetchBitstamp(
  instrument: string,
  tfHours: 1 | 4,
  opts?: { start?: number; limit?: number },
): Promise<Candle[]> {
  const base = baseAsset(instrument);
  if (!base) throw new Error(`Bitstamp: instrumento ${instrument} no soportado`);
  const q = new URLSearchParams({
    step: String(tfHours * 3600),
    limit: String(opts?.limit ?? 1000),
  });
  if (opts?.start != null) q.set("start", String(Math.floor(opts.start / 1000)));
  const json = await getJson(
    `https://www.bitstamp.net/api/v2/ohlc/${base.toLowerCase()}usd/?${q}`,
  );
  return bitstampRows(json);
}

export async function fetchCoinbase(
  instrument: string,
  tfHours: 1 | 4,
  now: number,
): Promise<Candle[]> {
  if (tfHours !== 1) throw new Error("Coinbase: solo velas de 1h");
  const base = baseAsset(instrument);
  if (!base) throw new Error(`Coinbase: instrumento ${instrument} no soportado`);
  const out: Candle[] = [];
  // 300 candles per request; 3 pages ≈ 900h.
  for (let page = 0; page < 3; page++) {
    const end = now - page * 300 * HOUR_MS;
    const start = end - 300 * HOUR_MS;
    const json = (await getJson(
      `https://api.exchange.coinbase.com/products/${base}-USD/candles?granularity=3600&start=${new Date(start).toISOString()}&end=${new Date(end).toISOString()}`,
    )) as number[][];
    if (!Array.isArray(json)) throw new Error("Coinbase: respuesta sin velas");
    for (const r of json) {
      out.push({ t: r[0] * 1000, l: r[1], h: r[2], o: r[3], c: r[4], v: r[5] });
    }
  }
  const seen = new Set<number>();
  return out
    .filter((c) => (seen.has(c.t) ? false : (seen.add(c.t), true)))
    .sort((a, b) => a.t - b.t);
}

/* ------------------------------------------------------------- Exness API */

function pickNum(item: Record<string, unknown>, side: string | null, field: "o" | "h" | "l" | "c"): number | null {
  const names =
    field === "o"
      ? ["open", "o"]
      : field === "h"
        ? ["high", "h"]
        : field === "l"
          ? ["low", "l"]
          : ["close", "c"];
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const tryKeys: Array<() => unknown> = [];
  for (const n of names) {
    if (side) {
      tryKeys.push(() => (item[side] as Record<string, unknown> | undefined)?.[n]);
      tryKeys.push(() => item[`${side}_${n}`]);
      tryKeys.push(() => item[`${n}_${side}`]);
      tryKeys.push(() => item[`${side}${cap(n)}`]);
      tryKeys.push(() => item[`${n}${cap(side)}`]);
    } else {
      tryKeys.push(() => item[n]);
    }
  }
  for (const f of tryKeys) {
    const v = f();
    if (v == null || v === "") continue;
    const x = numOf(v);
    if (Number.isFinite(x)) return x;
  }
  return null;
}

function parseTime(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v < 1e11 ? v * 1000 : v;
  if (typeof v === "string" && v) {
    const n = Number(v);
    if (Number.isFinite(n)) return n < 1e11 ? n * 1000 : n;
    const d = Date.parse(v);
    if (Number.isFinite(d)) return d;
  }
  return null;
}

/**
 * Tolerant parser for the Exness candle payload (shape verified only against
 * the public docs): array under candles/data/items/result, each item with a
 * time and OHLC either plain or split into bid/ask. Returns mid candles and
 * the last bid/ask close pair.
 */
export function parseExnessCandles(json: unknown): {
  candles: Candle[];
  quote: Quote | null;
} {
  const root = json as Record<string, unknown>;
  const arr: unknown[] | null = Array.isArray(json)
    ? json
    : ([root?.candles, root?.data, root?.items, root?.result, root?.items]
        .find((x) => Array.isArray(x)) as unknown[] | undefined) ?? null;
  if (!arr) {
    throw new Error(
      `Exness candles: forma inesperada (claves: ${Object.keys(root ?? {}).slice(0, 8).join(",")})`,
    );
  }
  const candles: Candle[] = [];
  let quote: Quote | null = null;
  for (const raw of arr) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const t = parseTime(item.time ?? item.timestamp ?? item.t ?? item.open_time ?? item.start);
    if (t == null) continue;
    const ohlc = (side: string | null) => {
      const o = pickNum(item, side, "o");
      const h = pickNum(item, side, "h");
      const l = pickNum(item, side, "l");
      const c = pickNum(item, side, "c");
      return o != null && h != null && l != null && c != null ? { o, h, l, c } : null;
    };
    const plain = ohlc(null);
    const bid = ohlc("bid");
    const ask = ohlc("ask");
    let m = plain;
    if (!m && bid && ask) {
      m = {
        o: (bid.o + ask.o) / 2,
        h: (bid.h + ask.h) / 2,
        l: (bid.l + ask.l) / 2,
        c: (bid.c + ask.c) / 2,
      };
    } else if (!m) {
      m = bid ?? ask;
    }
    if (!m) continue;
    if (bid && ask) quote = { bid: bid.c, ask: ask.c };
    candles.push({ t, ...m });
  }
  candles.sort((a, b) => a.t - b.t);
  return { candles, quote };
}

function tfLabel(tfHours: 1 | 4): string {
  return tfHours === 4 ? "H4" : "H1";
}

async function fetchExnessCandles(
  api: ExnessCandleApi,
  instrument: string,
  tfHours: 1 | 4,
  now: number,
): Promise<Candle[]> {
  let lastErr: unknown;
  for (const n of [700, 400]) {
    try {
      const json = await api.getCandles({
        instrument,
        timeframe: tfLabel(tfHours),
        priceType: "both",
        from: new Date(now - n * tfHours * HOUR_MS).toISOString(),
        to: new Date(now).toISOString(),
      });
      return parseExnessCandles(json).candles;
    } catch (err) {
      lastErr = err;
      const code = (err as { statusCode?: number }).statusCode;
      if (code !== 400) break;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Current bid/ask from the latest M1 candle (REST has no tick endpoint). */
export async function fetchExnessQuote(
  api: ExnessCandleApi,
  instrument: string,
  now: number,
): Promise<Quote | null> {
  const json = await api.getCandles({
    instrument,
    timeframe: "M1",
    priceType: "both",
    from: new Date(now - 5 * 60_000).toISOString(),
    to: new Date(now).toISOString(),
  });
  const { quote } = parseExnessCandles(json);
  return quote && quote.ask >= quote.bid && quote.bid > 0 ? quote : null;
}

/* ----------------------------------------------------------- validation */

export function validateCandles(
  candles: Candle[],
  tfHours: number,
): string | null {
  const tf = tfHours * HOUR_MS;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (![c.t, c.o, c.h, c.l, c.c].every(Number.isFinite) || c.c <= 0) {
      return "valores no numéricos";
    }
    const eps = c.c * 1e-6;
    if (c.h + eps < Math.max(c.o, c.c) || c.l - eps > Math.min(c.o, c.c)) {
      return "OHLC inconsistente";
    }
    if (i > 0) {
      const d = c.t - candles[i - 1].t;
      if (d <= 0) return "velas desordenadas";
      if (d % tf !== 0) return "velas no alineadas al timeframe";
    }
  }
  return null;
}

function splitClosed(
  raw: Candle[],
  tfHours: number,
  now: number,
): { closed: Candle[]; forming: Candle | null } {
  const tf = tfHours * HOUR_MS;
  const closed = raw.filter((c) => c.t + tf <= now);
  const forming = raw.find((c) => c.t <= now && now < c.t + tf) ?? null;
  return { closed, forming };
}

/* --------------------------------------------------------------- main API */

function publicOrder(source: CandleSource, tfHours: 1 | 4): CandleSource[] {
  if (source === "kraken" || source === "bitstamp" || source === "coinbase") {
    return [source];
  }
  const order: CandleSource[] = ["kraken", "bitstamp", "coinbase"];
  return tfHours === 4 ? order.filter((s) => s !== "coinbase") : order;
}

export async function fetchCandles(opts: FetchCandlesOpts): Promise<CandleBatch> {
  const { instrument, timeframeHours: tfh, now, minCandles: need } = opts;
  const key = `${opts.source}|${instrument}|${tfh}`;
  const hit = cache().get(key);
  const latestClosed = Math.floor(now / (tfh * HOUR_MS)) * tfh * HOUR_MS - tfh * HOUR_MS;
  if (
    hit &&
    now - hit.at < CACHE_TTL_MS &&
    hit.batch.candles.length > 0 &&
    hit.batch.candles[hit.batch.candles.length - 1].t >= latestClosed
  ) {
    return hit.batch;
  }

  const order: CandleSource[] = [];
  if (opts.source === "exness") order.push("exness");
  else if (opts.source === "auto") {
    if (opts.exness) order.push("exness");
    order.push(...publicOrder("auto", tfh));
  } else order.push(...publicOrder(opts.source, tfh));

  const tried: string[] = [];
  let best: CandleBatch | null = null;
  for (const src of order) {
    try {
      let raw: Candle[];
      if (src === "exness") {
        if (!opts.exness) throw new Error("sin cliente Exness");
        raw = await fetchExnessCandles(opts.exness, instrument, tfh, now);
      } else if (src === "kraken") raw = await fetchKraken(instrument, tfh);
      else if (src === "bitstamp") raw = await fetchBitstamp(instrument, tfh);
      else raw = await fetchCoinbase(instrument, tfh, now);

      const bad = validateCandles(raw, tfh);
      if (bad) throw new Error(`velas inválidas (${bad})`);
      const { closed, forming } = splitClosed(raw, tfh, now);
      if (closed.length < need) {
        throw new Error(`solo ${closed.length} velas cerradas (< ${need})`);
      }
      const batch: CandleBatch = { candles: closed, forming, source: src, tried: [...tried] };
      // A source that lags behind the latest closed candle: keep as a fallback
      // but give the next one a chance.
      if (closed[closed.length - 1].t < latestClosed) {
        tried.push(`${src}: vela ${new Date(latestClosed).toISOString().slice(11, 16)} aún no publicada`);
        if (!best) best = batch;
        continue;
      }
      cache().set(key, { at: now, key, batch });
      return batch;
    } catch (err) {
      tried.push(`${src}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (best) {
    best.tried = tried;
    return best;
  }
  throw new Error(`Sin fuente de velas (${tried.join(" | ")})`);
}

/* --------------------------------------------------------- history (backtest) */

/** Page Bitstamp OHLC (1000 per request) from `fromMs` up to `toMs`. */
export async function fetchBitstampHistory(
  instrument: string,
  tfHours: 1 | 4,
  fromMs: number,
  toMs: number,
  onProgress?: (n: number) => void,
): Promise<Candle[]> {
  const tf = tfHours * HOUR_MS;
  const out = new Map<number, Candle>();
  let cursor = Math.ceil(fromMs / tf) * tf;
  let stalls = 0;
  while (cursor < toMs) {
    let rows: Candle[] = [];
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        rows = await fetchBitstamp(instrument, tfHours, { start: cursor, limit: 1000 });
        break;
      } catch (err) {
        if (attempt === 3) throw err;
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      }
    }
    const before = out.size;
    for (const r of rows) if (r.t < toMs) out.set(r.t, r);
    onProgress?.(out.size);
    if (rows.length === 0) {
      cursor += 1000 * tf;
      stalls++;
      if (stalls > 5) break;
      continue;
    }
    stalls = 0;
    const last = rows[rows.length - 1].t;
    cursor = Math.max(cursor + tf, last + tf);
    if (out.size === before && rows.length < 1000) break;
    await new Promise((r) => setTimeout(r, 120));
  }
  return [...out.values()].sort((a, b) => a.t - b.t);
}
