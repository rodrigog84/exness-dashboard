/**
 * Live trend-following tick. Browser-independent: takes the full robot state
 * (StrategyConfig, including `trend` params and `trendRuntime`), mutates it and
 * returns what happened. The browser (Hobby) or a future cron/worker just has
 * to persist the state between calls.
 *
 * Per tick:
 *  1. snapshot (equity + positions), instrument limits (cached 24h)
 *  2. reconcile: managed position closed by the broker (SL/TP) -> bookkeeping
 *  3. day PnL (UTC, equity based) -> daily-loss pause
 *  4. open position: SL / TP / trailing on the live price
 *  5. only if a NEW closed candle exists: fetch candles, indicators, signal;
 *     close on opposite cross; if flat, gate (day pause, cooldown, stale
 *     signal, spread, sizing) and open with SL/TP sent to the broker.
 */

import {
  ExnessApiError,
  positionId,
  type ExnessTraderClient,
  type Settings,
} from "../exness";
import { pushMovement } from "../movements";
import type { StrategyConfig } from "../strategy";
import {
  fetchCandles,
  fetchExnessQuote,
  type CandleBatch,
} from "./candles";
import {
  entryBlocker,
  evaluateClose,
  cooldownUntilAfterLoss,
  formatPrice,
  formatVolume,
  latestClosedCandleTime,
  maxEntryDelayMs,
  minCandles,
  nextEvalTime,
  planEntry,
  positionFromPlan,
  spreadBlocker,
  stepPosition,
  timeframeMs,
  updateDay,
  type EntryPlan,
  type Side,
} from "./engine";
import {
  DEFAULT_LIMITS,
  type CloseReason,
  type InstrumentLimits,
  type TrendPos,
  type TrendRuntimePos,
} from "./params";

export type TickLog = { level: "info" | "ok" | "warn" | "error"; text: string };

export type TrendTickDeps = {
  now?: () => number;
  candles?: typeof fetchCandles;
};

export type TrendOutcome = {
  action: "noop" | "open" | "close" | "error";
  detail?: string;
  reason?: CloseReason;
  logs: TickLog[];
};

type Json = Record<string, unknown>;

function numField(obj: Json, keys: string[]): number | null {
  for (const key of keys) {
    const v = obj[key];
    if (v == null || v === "") continue;
    const n = typeof v === "number" ? v : Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

const fmtN = (n: number, d = 2) =>
  n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16) + "Z";

function isClientError(err: unknown): boolean {
  return (
    err instanceof ExnessApiError &&
    err.statusCode != null &&
    err.statusCode >= 400 &&
    err.statusCode < 500 &&
    err.statusCode !== 429
  );
}

async function ensureLimits(
  client: ExnessTraderClient,
  s: StrategyConfig,
  now: number,
  log: (l: TickLog["level"], t: string) => void,
): Promise<InstrumentLimits> {
  const rt = s.trendRuntime;
  const cur = rt.limits;
  const ttl = cur?.assumed ? 10 * 60_000 : 24 * 3_600_000;
  if (cur && now - cur.at < ttl) return cur;
  try {
    let c = (await client.getInstrumentConditions(s.instrument)) as Json;
    if (c.conditions && typeof c.conditions === "object") c = c.conditions as Json;
    const volumeMin = numField(c, ["volume_min", "min_volume"]);
    const volumeMax = numField(c, ["volume_max", "max_volume"]);
    const volumeStep = numField(c, ["volume_step", "step_volume"]);
    if (volumeMin == null || volumeMax == null || volumeStep == null) {
      throw new Error("conditions sin volume_min/max/step");
    }
    const limits: InstrumentLimits = {
      volumeMin,
      volumeMax,
      volumeStep,
      pointDigits: Math.round(numField(c, ["point_digits", "digits"]) ?? 2),
      contractSize:
        numField(c, ["contract_size", "trade_contract_size", "lot_size"]) ?? 1,
      at: now,
      assumed: false,
    };
    rt.limits = limits;
    return limits;
  } catch (err) {
    if (err instanceof ExnessApiError && err.statusCode === 429) throw err;
    log(
      "warn",
      `No se pudieron leer las condiciones del instrumento (${err instanceof Error ? err.message : String(err)}); uso mínimos asumidos`,
    );
    rt.limits = { ...DEFAULT_LIMITS, at: now, assumed: true };
    return rt.limits;
  }
}

function clearPosition(s: StrategyConfig) {
  s.managedPositionId = null;
  s.managedSide = null;
  s.openPrice = null;
  s.ticksSinceOpen = 0;
  s.status = "flat";
  s.trendRuntime.pos = null;
}

function rebase(pos: TrendPos, fill: number): TrendPos {
  const shift = fill - pos.entry;
  return {
    ...pos,
    entry: fill,
    sl: pos.sl + shift,
    tp: pos.tp != null ? pos.tp + shift : null,
    best: fill,
  };
}

export async function tickTrend(
  client: ExnessTraderClient,
  settings: Settings,
  s: StrategyConfig,
  deps: TrendTickDeps = {},
): Promise<TrendOutcome> {
  const now = (deps.now ?? Date.now)();
  const p = s.trend;
  const rt = s.trendRuntime;
  const tf = timeframeMs(p);
  const logs: TickLog[] = [];
  const log = (level: TickLog["level"], text: string) =>
    logs.push({ level, text });
  const out = (
    action: TrendOutcome["action"],
    detail?: string,
    reason?: CloseReason,
  ): TrendOutcome => ({ action, detail, reason, logs });

  rt.nextEvalAt = nextEvalTime(now, p);

  const snapshot = await client.getSnapshot();
  const positions = client.extractPositions(snapshot);
  const equity = numField(client.extractAccountState(snapshot), ["equity"]);
  if (equity != null) rt.equity = equity;
  const limits = await ensureLimits(client, s, now, log);

  const findLive = (id: string | null) =>
    id
      ? (positions.find((x) => positionId(x) === id) as Json | undefined)
      : undefined;

  /* 2. reconcile: closed by the broker (its SL/TP) or by hand */
  if (s.managedPositionId && !findLive(s.managedPositionId)) {
    const pos = rt.pos;
    const pnl =
      equity != null && pos?.equityAtOpen != null
        ? equity - pos.equityAtOpen
        : (pos?.lastProfit ?? null);
    const pid = s.managedPositionId;
    if (pnl != null && pnl < 0) {
      rt.cooldownUntil = cooldownUntilAfterLoss(now, p);
    }
    s.lastCloseReason = "broker";
    s.lastAction = "close:broker";
    const text = `Posición ${pid} cerrada fuera del robot (SL/TP del broker o manual)${pnl != null ? `, resultado aprox. ${pnl >= 0 ? "+" : ""}${fmtN(pnl)}` : ""}${pnl != null && pnl < 0 ? ` · cooldown ${p.cooldownCandles} velas` : ""}`;
    log(pnl != null && pnl < 0 ? "warn" : "ok", text);
    pushMovement({
      kind: "close",
      instrument: s.instrument,
      side: s.managedSide ?? undefined,
      positionId: pid,
      pnl,
      reason: "broker",
      message: text,
      meta: { action: "reconcile_flat" },
    });
    clearPosition(s);
  }

  /* adopt an open whose confirmation was lost */
  if (!s.managedPositionId && s.pendingBefore) {
    const known = new Set(s.pendingBefore);
    const adopted = positions.find((x) => {
      const id = positionId(x);
      return (
        id &&
        !known.has(id) &&
        String(x.instrument ?? "").toUpperCase() === s.instrument
      );
    }) as Json | undefined;
    s.pendingBefore = null;
    if (adopted) {
      const id = positionId(adopted)!;
      const sideRaw = String(adopted.side ?? "").toLowerCase();
      const fill = numField(adopted, ["open_price", "price", "avg_price"]);
      s.managedPositionId = id;
      s.managedSide = sideRaw === "sell" ? "sell" : "buy";
      s.openPrice = fill;
      s.ticksSinceOpen = 0;
      s.status = "in_position";
      s.lastAction = `adopt:${s.managedSide}`;
      if (rt.pendingOpen && fill != null) {
        rt.pos = {
          ...rebase(rt.pendingOpen.pos, fill),
          equityAtOpen: rt.pendingOpen.equityAtOpen,
          brokerStops: rt.pendingOpen.brokerStops,
          lastPrice: fill,
          lastProfit: null,
        };
      }
      rt.pendingOpen = null;
      log("ok", `Adoptó posición ${id} (open previo sin confirmar)`);
      pushMovement({
        kind: "info",
        instrument: s.instrument,
        positionId: id,
        message: `Robot adoptó posición ${id} (open previo sin confirmar)`,
        meta: { action: "adopt" },
      });
    } else {
      rt.pendingOpen = null;
    }
  }

  /* 3. day PnL + daily-loss pause */
  const wasPaused = rt.dayPaused;
  const day = updateDay(
    {
      dayKey: rt.dayKey,
      startEquity: rt.dayStartEquity,
      paused: rt.dayPaused,
      pnl: rt.dayPnl,
      pnlPct: rt.dayPnlPct,
    },
    now,
    equity,
    p,
  );
  rt.dayKey = day.dayKey;
  rt.dayStartEquity = day.startEquity;
  rt.dayPaused = day.paused;
  rt.dayPnl = day.pnl;
  rt.dayPnlPct = day.pnlPct;
  if (day.paused && !wasPaused) {
    log(
      "warn",
      `Pausa del día: pérdida ${fmtN(day.pnlPct ?? 0)}% ≤ -${p.dailyLossPct}% (sin nuevas entradas hasta 00:00 UTC)`,
    );
  }

  /* a position the robot does not know the plan of (legacy / manual adopt) */
  if (s.managedPositionId && !rt.pos) {
    const live = findLive(s.managedPositionId)!;
    const entry = numField(live, ["open_price", "price", "avg_price"]);
    const vol = numField(live, ["volume"]);
    const sideRaw = String(live.side ?? s.managedSide ?? "").toLowerCase();
    if (entry != null && vol != null && (sideRaw === "buy" || sideRaw === "sell")) {
      const side: Side = sideRaw;
      const dist =
        rt.indicators != null
          ? p.slAtrMult * rt.indicators.atr
          : entry * (Math.max(s.slPct, 0.3) / 100);
      const dir = side === "buy" ? 1 : -1;
      rt.pos = {
        side,
        entry,
        sl: entry - dir * dist,
        tp: p.tpR > 0 ? entry + dir * p.tpR * dist : null,
        vol,
        atr: dist / p.slAtrMult,
        riskDist: dist,
        riskUsd: dist * vol * limits.contractSize,
        entryCandleTime: rt.lastCandleTime ?? latestClosedCandleTime(now, p),
        best: entry,
        trailActive: false,
        equityAtOpen: equity,
        brokerStops: false,
        lastPrice: null,
        lastProfit: null,
      };
      s.managedSide = side;
      log("info", `Posición ${s.managedPositionId} sin plan de tendencia: SL ${fmtN(rt.pos.sl)} asignado por el robot`);
    }
  }

  const closeNow = async (
    reason: CloseReason,
    ctx: { price: number | null; profit: number | null },
  ) => {
    const pid = s.managedPositionId!;
    const pos = rt.pos;
    s.status = "closing";
    s.lastAction = `closing:${reason}`;
    const ack = await client.closePosition(pid);
    const op = String(ack.operation_id ?? "");
    if (op) {
      await client.waitForOperation(op, {
        timeoutSec: Math.min(settings.pollTimeoutSec, 30),
      });
    }
    const pnl =
      ctx.profit ??
      (equity != null && pos?.equityAtOpen != null
        ? equity - pos.equityAtOpen
        : null);
    if (pnl != null && pnl < 0) {
      rt.cooldownUntil = cooldownUntilAfterLoss(now, p);
    }
    const r = pos && pnl != null && pos.riskUsd > 0 ? pnl / pos.riskUsd : null;
    const label: Record<CloseReason, string> = {
      sl: "stop loss",
      tp: "take profit",
      trail: "trailing stop",
      cross: "cruce EMA contrario",
      timeout: "timeout",
      broker: "broker",
    };
    const text = `Cerró ${s.managedSide ?? ""} ${pid} por ${label[reason]}${ctx.price != null ? ` @ ${fmtN(ctx.price)}` : ""}${pnl != null ? ` · pnl ${pnl >= 0 ? "+" : ""}${fmtN(pnl)}` : ""}${r != null ? ` (${r >= 0 ? "+" : ""}${r.toFixed(2)}R)` : ""}${pnl != null && pnl < 0 && p.cooldownCandles > 0 ? ` · cooldown ${p.cooldownCandles} velas` : ""}`;
    log(pnl != null && pnl < 0 ? "warn" : "ok", text);
    pushMovement({
      kind: "close",
      instrument: s.instrument,
      side: s.managedSide ?? undefined,
      positionId: pid,
      operationId: op || undefined,
      pnl,
      reason,
      message: `Robot ${text}`,
      meta: { reason, currentPrice: ctx.price, ticksHeld: s.ticksSinceOpen },
    });
    s.lastCloseReason = reason;
    s.lastAction = `close:${reason}`;
    s.lastError = null;
    clearPosition(s);
  };

  /* 4. open position: SL / TP / trailing on the live price */
  let closed: TrendOutcome | null = null;
  if (s.managedPositionId && rt.pos) {
    const live = findLive(s.managedPositionId)!;
    s.ticksSinceOpen += 1;
    s.status = "in_position";
    const profit = numField(live, ["profit", "unrealized_pnl", "pnl"]);
    let price = numField(live, ["current_price", "mark_price"]);
    if (price == null && profit != null && rt.pos.vol > 0) {
      const dir = rt.pos.side === "buy" ? 1 : -1;
      price = rt.pos.entry + (dir * profit) / (rt.pos.vol * limits.contractSize);
    }
    const px = numField(live, ["open_price", "price", "avg_price"]);
    if (px != null) s.openPrice = px;
    rt.pos.lastProfit = profit;
    rt.pos.lastPrice = price;
    if (price != null) {
      const slBefore = rt.pos.sl;
      const ex = stepPosition(rt.pos, { h: price, l: price }, p);
      if (!ex && rt.pos.sl !== slBefore) {
        log("info", `Trailing: SL sube a ${fmtN(rt.pos.sl)} (mejor precio ${fmtN(rt.pos.best)})`);
      }
      if (ex) {
        await closeNow(ex.reason, { price, profit });
        closed = out("close", s.managedPositionId ?? undefined, ex.reason);
      }
    }
  }

  /* 5. new closed candle? */
  const latest = latestClosedCandleTime(now, p);
  const evaluated = rt.lastCandleTime != null && rt.lastCandleTime >= latest;
  if (evaluated) {
    if (closed) return { ...closed, logs };
    if (rt.pos) {
      const pr = rt.pos.lastPrice;
      return out(
        "noop",
        `en posición ${rt.pos.side} ${rt.pos.vol} · ${pr != null ? fmtN(pr) : "?"} · SL ${fmtN(rt.pos.sl)}${rt.pos.tp != null ? ` TP ${fmtN(rt.pos.tp)}` : ""} · pnl ${rt.pos.lastProfit != null ? fmtN(rt.pos.lastProfit) : "?"}`,
      );
    }
    return out("noop", `esperando vela de ${hhmm(latest + tf)} (próx. evaluación ${hhmm(rt.nextEvalAt)})`);
  }

  let batch: CandleBatch;
  try {
    batch = await (deps.candles ?? fetchCandles)({
      instrument: s.instrument,
      timeframeHours: p.timeframeHours,
      source: p.candleSource,
      now,
      minCandles: minCandles(p),
      exness: client,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    s.lastError = msg;
    log("error", `Velas no disponibles: ${msg} (reintento en el próximo tick)`);
    return closed ? { ...closed, logs } : out("error", msg);
  }
  if (batch.tried.length > 0) {
    log("info", `Fuente de velas: ${batch.source} (fallback tras: ${batch.tried.join(" | ")})`);
  }
  const lastCandle = batch.candles[batch.candles.length - 1];
  if (lastCandle.t < latest) {
    return closed
      ? { ...closed, logs }
      : out("noop", `vela ${hhmm(latest)} aún no publicada por ${batch.source}`);
  }

  const ev = evaluateClose(batch.candles, p, rt.pos, batch.source);
  if (!ev) {
    const msg = "indicadores no calculables (velas insuficientes)";
    s.lastError = msg;
    log("error", msg);
    return closed ? { ...closed, logs } : out("error", msg);
  }
  rt.indicators = ev.indicators;
  const ind = ev.indicators;
  log(
    "info",
    `Vela ${hhmm(lastCandle.t)} cerrada @ ${fmtN(ind.close)} [${batch.source}] · EMA${p.emaFast} ${fmtN(ind.emaFast)} EMA${p.emaSlow} ${fmtN(ind.emaSlow)} EMA${p.emaTrend} ${fmtN(ind.emaTrend)} ATR ${fmtN(ind.atr)} · señal: ${ev.signal ?? "ninguna"}`,
  );
  const nowIso = new Date(now).toISOString();
  rt.lastSignal = {
    at: nowIso,
    candleTime: lastCandle.t,
    side: ev.signal,
    note: ev.signal
      ? `${ev.signal === "buy" ? "EMA rápida cruza arriba y precio > EMA tendencia" : "EMA rápida cruza abajo y precio < EMA tendencia"}`
      : "sin cruce válido",
  };

  let result: TrendOutcome | null = closed;

  /* exit on trend reversal */
  if (s.managedPositionId && rt.pos && ev.crossExit) {
    await closeNow("cross", {
      price: rt.pos.lastPrice ?? ind.close,
      profit: rt.pos.lastProfit,
    });
    result = out("close", undefined, "cross");
  }

  /* entry */
  if (!s.managedPositionId && ev.signal) {
    const side = ev.signal;
    const closeTime = lastCandle.t + tf;
    const stale = now - closeTime > maxEntryDelayMs(p);
    const blocked = entryBlocker({
      candleTime: lastCandle.t,
      dayPaused: rt.dayPaused,
      cooldownUntil: rt.cooldownUntil,
    });
    if (stale) {
      log("warn", `Señal ${side} de la vela ${hhmm(lastCandle.t)} vencida (${Math.round((now - closeTime) / 60000)} min tarde): no se opera`);
    } else if (blocked) {
      log("warn", `Señal ${side} bloqueada: ${blocked}`);
    } else if (rt.equity == null) {
      log("warn", `Señal ${side} omitida: equity desconocido`);
    } else {
      let quote = null;
      try {
        quote = await fetchExnessQuote(client, s.instrument, now);
      } catch {
        quote = null;
      }
      const ref = quote
        ? side === "buy"
          ? quote.ask
          : quote.bid
        : (batch.forming?.c ?? ind.close);
      const spread = quote ? quote.ask - quote.bid : null;
      rt.lastSpread = spread;
      rt.lastSpreadPct = spread != null && ref > 0 ? (spread / ref) * 100 : null;
      const spreadBlock = spreadBlocker(spread, ref, p);
      if (spreadBlock) {
        log("warn", `Señal ${side} bloqueada: ${spreadBlock}`);
      } else {
        if (!quote) log("info", "Spread desconocido (sin quote M1): filtro de spread omitido");
        const plan = planEntry({
          side,
          ref,
          atr: ind.atr,
          equity: rt.equity,
          p,
          limits,
        });
        if (!plan.ok) {
          log("warn", `Señal ${side} omitida: ${plan.reason}`);
        } else {
          const opened = await openTrend({
            client,
            settings,
            s,
            log,
            positions,
            plan: plan.plan,
            ref,
            atr: ind.atr,
            candleTime: lastCandle.t,
            limits,
            now,
          });
          if (opened) result = out("open", opened);
        }
      }
    }
  }

  rt.lastCandleTime = lastCandle.t;
  return result ? { ...result, logs } : out("noop", "vela evaluada");
}

async function openTrend(c: {
  client: ExnessTraderClient;
  settings: Settings;
  s: StrategyConfig;
  log: (l: TickLog["level"], t: string) => void;
  positions: Json[];
  plan: EntryPlan;
  ref: number;
  atr: number;
  candleTime: number;
  limits: InstrumentLimits;
  now: number;
}): Promise<string | null> {
  const { client, settings, s, log, plan, limits } = c;
  const rt = s.trendRuntime;
  const p = s.trend;
  const side = plan.side;
  const digits = limits.pointDigits;
  const volume = formatVolume(plan.volume, limits);

  s.status = "opening";
  s.side = side;
  s.lastAction = `opening:${side}`;
  s.pendingBefore = c.positions
    .map((x) => positionId(x))
    .filter(Boolean) as string[];
  const planned = positionFromPlan(plan, c.ref, c.atr, c.candleTime, p);
  rt.riskUsd = plan.riskUsd;

  let brokerStops = false;
  let operationId = "";
  for (const withStops of [true, false]) {
    try {
      const ack = await client.openPosition({
        instrument: s.instrument,
        side,
        volume,
        ...(withStops
          ? {
              stopLossPrice: formatPrice(plan.sl, digits),
              takeProfitPrice:
                plan.tp != null ? formatPrice(plan.tp, digits) : undefined,
            }
          : {}),
      });
      operationId = String(ack.operation_id ?? "");
      rt.pendingOpen = {
        pos: planned,
        equityAtOpen: rt.equity,
        brokerStops: withStops,
      };
      if (operationId) {
        const op = await client.waitForOperation(operationId, {
          timeoutSec: Math.min(settings.pollTimeoutSec, 30),
        });
        const st = String(op.status ?? "").toLowerCase();
        if (st === "rejected" || st === "failed") {
          if (withStops) {
            log("warn", `El broker rechazó el open con SL/TP (${st}); reintento sin SL/TP del broker (el robot los vigila)`);
            continue;
          }
          const msg = `Open ${st}`;
          s.lastError = msg;
          s.status = "flat";
          s.lastAction = "open_error";
          s.pendingBefore = null;
          rt.pendingOpen = null;
          log("error", msg);
          pushMovement({ kind: "error", instrument: s.instrument, side, operationId, message: msg, meta: { status: st } });
          return null;
        }
      }
      brokerStops = withStops;
      break;
    } catch (err) {
      if (withStops && isClientError(err)) {
        log("warn", `El broker rechazó el open con SL/TP (${err instanceof Error ? err.message : String(err)}); reintento sin SL/TP del broker`);
        continue;
      }
      throw err;
    }
  }

  const before = new Set(s.pendingBefore ?? []);
  let found: Json | null = null;
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const snap = await client.getSnapshot();
    for (const x of client.extractPositions(snap)) {
      const id = positionId(x);
      if (!id || before.has(id)) continue;
      if (String(x.instrument ?? "").toUpperCase() === s.instrument) {
        found = x;
        break;
      }
    }
    if (found) break;
    await new Promise((r) => setTimeout(r, 1500));
  }

  if (!found) {
    s.status = "flat";
    s.lastAction = "open_pending";
    log("warn", `Open ${side} enviado pero la posición aún no aparece; se adoptará en el próximo tick`);
    pushMovement({ kind: "open", instrument: s.instrument, side, volume, operationId: operationId || undefined, message: `Robot envió open ${side} ${volume} (posición aún no en snapshot)`, meta: { action: "open" } });
    return "pending";
  }

  const id = positionId(found)!;
  const fill = numField(found, ["open_price", "price", "avg_price"]) ?? c.ref;
  const base = rebase(planned, fill);
  rt.pos = {
    ...base,
    equityAtOpen: rt.pendingOpen?.equityAtOpen ?? rt.equity,
    brokerStops,
    lastPrice: fill,
    lastProfit: null,
  } satisfies TrendRuntimePos;
  rt.pendingOpen = null;
  s.pendingBefore = null;
  s.managedPositionId = id;
  s.managedSide = side;
  s.openPrice = fill;
  s.ticksSinceOpen = 0;
  s.lastError = null;
  s.lastCloseReason = null;
  s.lastAction = `open:${side}`;
  s.status = "in_position";
  const text = `Abrió ${side.toUpperCase()} ${volume} ${s.instrument} @ ${fmtN(fill)} · SL ${fmtN(base.sl)}${base.tp != null ? ` · TP ${fmtN(base.tp)}` : ""} · riesgo $${fmtN(plan.riskUsd)} (${p.riskPct}%)${brokerStops ? " · SL/TP en el broker" : " · SL/TP vigilados por el robot"}`;
  log("ok", text);
  pushMovement({
    kind: "open",
    instrument: s.instrument,
    side,
    volume,
    positionId: id,
    operationId: operationId || undefined,
    message: `Robot ${text}`,
    meta: { action: "open", entryMode: "trend", openPrice: fill, sl: base.sl, tp: base.tp, riskUsd: plan.riskUsd, brokerStops },
  });
  return id;
}
