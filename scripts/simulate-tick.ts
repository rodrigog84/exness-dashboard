/**
 * Offline replay of the LIVE tick (lib/trend/runner.ts through tickStrategy)
 * against a fake broker and cached Bitstamp candles. No network, no keys.
 *
 *   npx tsx scripts/backtest.ts --years 1 --tf 1   # fills scripts/.cache first
 *   npx tsx scripts/simulate-tick.ts [hours=1|4] [days=60]
 *
 * Checks the plumbing the backtest cannot: state-in/state-out between ticks,
 * "only evaluate on a new closed candle", broker-side SL/TP reconcile,
 * cooldown, sizing against instrument limits.
 */

import fs from "node:fs";
import path from "node:path";
import { tickStrategy, hydrateStrategy, type StrategyConfig } from "../lib/strategy";
import type { Candle } from "../lib/trend/engine";
import { HOUR_MS } from "../lib/trend/engine";
import type { CandleBatch } from "../lib/trend/candles";

const tfh = (Number(process.argv[2]) === 4 ? 4 : 1) as 1 | 4;
const days = Number(process.argv[3] ?? 60);

const dir = path.join(__dirname, ".cache");
const file = fs
  .readdirSync(dir)
  .filter((f) => f.includes(`-${tfh}h-`))
  .sort()
  .pop();
if (!file) throw new Error("run scripts/backtest.ts first to fill the cache");
const all = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as Candle[];
const tf = tfh * HOUR_MS;

const startIdx = Math.max(500, all.length - Math.ceil((days * 24) / tfh));
let now = all[startIdx].t + tf + 20_000;
const end = all[all.length - 1].t;

type FakePos = { id: string; side: string; volume: number; open: number; sl: number | null; tp: number | null };
let balance = 10_000;
let pos: FakePos | null = null;
let nextId = 1;
const priceNow = () => {
  const c = all.find((x) => x.t <= now && now < x.t + tf) ?? all[all.length - 1];
  return c.o + (c.c - c.o) * ((now - c.t) / tf);
};
const profit = () =>
  pos ? (pos.side === "buy" ? 1 : -1) * (priceNow() - pos.open) * pos.volume : 0;

const fake = {
  settings: { pollTimeoutSec: 5, accountId: "1", instrument: "BTCUSD" },
  async getSnapshot() {
    const px = priceNow();
    if (pos) {
      const hitSl = pos.sl != null && (pos.side === "buy" ? px <= pos.sl : px >= pos.sl);
      const hitTp = pos.tp != null && (pos.side === "buy" ? px >= pos.tp : px <= pos.tp);
      if (hitSl || hitTp) {
        balance += profit();
        pos = null;
      }
    }
    return {
      account_state: { equity: String(balance + profit()), balance: String(balance) },
      positions: pos
        ? [{ position_id: pos.id, instrument: "BTCUSD", side: pos.side, volume: String(pos.volume), open_price: String(pos.open), current_price: String(px), profit: String(profit()) }]
        : [],
    };
  },
  extractPositions(s: { positions: unknown[] }) { return s.positions as Record<string, unknown>[]; },
  extractAccountState(s: { account_state: Record<string, unknown> }) { return s.account_state; },
  async getInstrumentConditions() {
    return { volume_min: "0.01", volume_max: "100", volume_step: "0.01", point_digits: 2 };
  },
  async getCandles() { throw new Error("simulated: no exness candles"); },
  async openPosition(o: { side: string; volume: string; stopLossPrice?: string; takeProfitPrice?: string }) {
    pos = {
      id: String(nextId++),
      side: o.side,
      volume: Number(o.volume),
      open: priceNow(),
      sl: o.stopLossPrice ? Number(o.stopLossPrice) : null,
      tp: o.takeProfitPrice ? Number(o.takeProfitPrice) : null,
    };
    return { operation_id: "op" };
  },
  async closePosition() { balance += profit(); pos = null; return { operation_id: "op" }; },
  async waitForOperation() { return { status: "confirmed" }; },
};

function candlesUpTo(): CandleBatch {
  const closed = all.filter((c) => c.t + tf <= now).slice(-720);
  return {
    candles: closed,
    forming: all.find((c) => c.t <= now && now < c.t + tf) ?? null,
    source: "replay",
    tried: [],
  };
}

async function main() {
  let s: StrategyConfig = hydrateStrategy({ running: true, entryMode: "trend", trend: { timeframeHours: tfh } });
  let fetches = 0;
  let ticks = 0;
  const lines: string[] = [];
  while (now < end) {
    // state is round-tripped through JSON exactly like the browser does
    s = hydrateStrategy(JSON.parse(JSON.stringify(s)));
    const r = await tickStrategy(fake as never, fake.settings as never, s, {
      now: () => now,
      candles: async () => { fetches++; return candlesUpTo(); },
    });
    s = r.state;
    ticks++;
    for (const l of r.logs ?? []) {
      if (l.level !== "info" || l.text.startsWith("Trailing")) {
        lines.push(`${new Date(now).toISOString().slice(0, 16)} [${l.level}] ${l.text}`);
      }
    }
    now += 35_000;
  }
  console.log(lines.slice(0, 60).join("\n"));
  console.log(`\nticks=${ticks} candleFetches=${fetches} (expected ≈ ${Math.floor((end - all[startIdx].t) / tf)})`);
  console.log(`final equity=${(balance + profit()).toFixed(2)} open=${pos ? "yes" : "no"}`);
  const rt = s.trendRuntime;
  console.log(`lastSignal=${JSON.stringify(rt.lastSignal)} dayPnl=${rt.dayPnl?.toFixed(2)} cooldownUntil=${rt.cooldownUntil ? new Date(rt.cooldownUntil).toISOString() : "-"}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
