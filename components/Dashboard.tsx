"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { StrategyConfig as Strategy, TickResult } from "@/lib/strategy";
import { HOUR_MS, nextEvalTime } from "@/lib/trend/engine";
import {
  CANDLE_SOURCES,
  DEFAULT_TREND,
  defaultRuntime,
  sanitizeTrendParams,
  type CloseReason,
  type TrendParams,
} from "@/lib/trend/params";

type AccountPayload = {
  env: string;
  accountId: string;
  accountState: {
    balance: string | number | null;
    equity: string | number | null;
    margin: string | number | null;
    freeMargin: string | number | null;
    marginLevel: string | number | null;
    currency: string | null;
  };
  openPositionCount: number;
  positions?: Position[];
  accessPoint?: string | null;
  fetchedAt: string;
};

type Position = {
  id: string | null;
  instrument: string | null;
  side: string | null;
  volume: string | number | null;
  openPrice: string | number | null;
  currentPrice: string | number | null;
  profit: string | number | null;
};

type Movement = {
  id: string;
  at: string;
  kind: string;
  message: string;
  instrument?: string;
  pnl?: string | number | null;
  reason?: CloseReason;
};

type TickResponse = TickResult & { accessPoint?: string | null };

type RobotLogEntry = {
  id: string;
  at: string;
  level: "info" | "ok" | "warn" | "error";
  text: string;
};

type LastError = { at: string; message: string };

type PersistedRobot = {
  strategy: Strategy;
  log: RobotLogEntry[];
  lastError: LastError | null;
};

const TICK_BASE_MS = 35_000;
const TICK_MAX_MS = 60_000;
const RATE_LIMIT_MIN_MS = 60_000;
const RATE_LIMIT_MAX_MS = 300_000;
const REFRESH_MS = 20_000;
const AP_KEY = "exness-ap-v1";
const AP_MAX_AGE_MS = 25 * 60_000;
const LOG_MAX = 100;
const STORAGE_KEY = "exness-robot-v1";

function initialStrategy(): Strategy {
  return {
    running: false,
    instrument: "BTCUSD",
    volume: "0.01",
    side: "buy",
    entryMode: "trend",
    holdTicks: 10,
    slPct: 0.3,
    slUsd: 0,
    tpPct: 0,
    tpUsd: 0,
    trend: { ...DEFAULT_TREND },
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

function loadPersisted(): PersistedRobot | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const j = JSON.parse(raw) as Partial<PersistedRobot>;
    if (!j.strategy || typeof j.strategy !== "object") return null;
    const saved = j.strategy as Partial<Strategy>;
    const base = initialStrategy();
    const strategy: Strategy = {
      ...base,
      ...saved,
      trend: sanitizeTrendParams(saved.trend, base.trend),
      trendRuntime: { ...base.trendRuntime, ...(saved.trendRuntime ?? {}) },
      // state saved before the trend strategy existed: move to the new default mode
      entryMode: saved.trend ? (saved.entryMode ?? "trend") : "trend",
    };
    return {
      strategy,
      log: Array.isArray(j.log) ? j.log.slice(0, LOG_MAX) : [],
      lastError: j.lastError ?? null,
    };
  } catch {
    return null;
  }
}

function tickLogs(r: TickResponse): { level: RobotLogEntry["level"]; text: string }[] {
  if (r.logs) {
    const lines = r.logs.map((l) => ({ level: l.level, text: l.text }));
    if (r.action === "error" && !lines.some((l) => l.level === "error")) {
      lines.push(describeTick(r));
    }
    return lines;
  }
  return [describeTick(r)];
}

function describeTick(r: TickResponse): { level: RobotLogEntry["level"]; text: string } {
  switch (r.action) {
    case "open":
      return { level: "ok", text: `Abrió/adoptó posición ${r.detail ?? ""}`.trim() };
    case "close":
      return {
        level: "ok",
        text: `Cerró ${r.detail ?? ""} (${r.reason ?? "?"})`.trim(),
      };
    case "noop":
      return { level: "info", text: r.detail ?? "sin cambios" };
    case "rate_limited":
      return {
        level: "warn",
        text: `Rate limit de Exness, reintentando en ${r.retryAfterSec ?? 60}s`,
      };
    case "skipped":
      return { level: "info", text: `tick omitido (${r.detail ?? "—"})` };
    case "error":
      return { level: "error", text: r.detail ?? "error en tick" };
  }
}

function fmt(n: string | number | null | undefined, digits = 2): string {
  if (n == null || n === "") return "—";
  const num = typeof n === "number" ? n : Number(n);
  if (Number.isFinite(num)) {
    return num.toLocaleString("es-ES", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
  }
  return String(n);
}

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString("es-ES", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return iso;
  }
}

function statusLabel(s: Strategy | null): string {
  if (!s) return "—";
  if (!s.running) return "parado";
  if (s.status === "in_position" || s.managedPositionId) return "en posición";
  if (s.status === "opening") return "abriendo";
  if (s.status === "closing") return "cerrando";
  return "flat";
}

function readAccessPoint(): string | null {
  try {
    const raw = window.localStorage.getItem(AP_KEY);
    if (!raw) return null;
    const j = JSON.parse(raw) as { url?: string; at?: number };
    if (!j.url || !j.at || Date.now() - j.at > AP_MAX_AGE_MS) return null;
    return j.url;
  } catch {
    return null;
  }
}

function rememberAccessPoint(url: string | null | undefined) {
  if (!url) return;
  try {
    const raw = window.localStorage.getItem(AP_KEY);
    const j = raw ? (JSON.parse(raw) as { url?: string; at?: number }) : {};
    // keep the original timestamp while the access point is unchanged
    const at = j.url === url && j.at ? j.at : Date.now();
    window.localStorage.setItem(AP_KEY, JSON.stringify({ url, at }));
  } catch {
    /* ignore */
  }
}

type ApiFail = {
  ok: false;
  status: number;
  error: string;
  retryAfterSec?: number;
};

async function api<T>(
  path: string,
  init?: RequestInit,
): Promise<{ ok: true; data: T } | ApiFail> {
  const ap = readAccessPoint();
  const res = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(ap ? { "x-exn-ap": ap } : {}),
      ...(init?.headers || {}),
    },
  });
  const json = await res.json().catch(() => ({}));
  if (res.status === 401) {
    return { ok: false, status: 401, error: "No autorizado" };
  }
  if (!res.ok) {
    const j = json as { error?: string; retryAfterSec?: number };
    const header = Number(res.headers.get("retry-after"));
    return {
      ok: false,
      status: res.status,
      error: j.error || `HTTP ${res.status}`,
      retryAfterSec:
        j.retryAfterSec ?? (Number.isFinite(header) && header > 0 ? header : undefined),
    };
  }
  rememberAccessPoint((json as { accessPoint?: string | null }).accessPoint);
  return { ok: true, data: json as T };
}

export function Dashboard({ needsAuth }: { needsAuth: boolean }) {
  const [account, setAccount] = useState<AccountPayload | null>(null);
  const [positions, setPositions] = useState<Position[]>([]);
  const [movements, setMovements] = useState<Movement[]>([]);
  const [strategy, setStrategy] = useState<Strategy | null>(null);
  const [robotLog, setRobotLog] = useState<RobotLogEntry[]>([]);
  const [lastError, setLastError] = useState<LastError | null>(null);
  const [nextTickAt, setNextTickAt] = useState<number | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [instrument, setInstrument] = useState("BTCUSD");
  const [volume, setVolume] = useState("0.01");
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [entryMode, setEntryMode] = useState<Strategy["entryMode"]>("trend");
  const [trendForm, setTrendForm] = useState<TrendParams>({ ...DEFAULT_TREND });
  const setTrendField = <K extends keyof TrendParams>(k: K, v: TrendParams[K]) =>
    setTrendForm((t) => ({ ...t, [k]: v }));
  const [clock, setClock] = useState(() => Date.now());
  const [holdTicks, setHoldTicks] = useState(10);
  const [slPct, setSlPct] = useState(0.3);
  const [slUsd, setSlUsd] = useState(0);
  const [tpPct, setTpPct] = useState(0);
  const [tpUsd, setTpUsd] = useState(0);
  const [secret, setSecret] = useState("");
  const [authed, setAuthed] = useState(!needsAuth);
  const [tickHealth, setTickHealth] = useState<"ok" | "backoff" | "ratelimit" | "idle">(
    "idle",
  );
  const tickLock = useRef(false);
  const backoffMs = useRef(TICK_BASE_MS);
  const strategyRef = useRef<Strategy>(initialStrategy());
  const logRef = useRef<RobotLogEntry[]>([]);
  const lastErrorRef = useRef<LastError | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    const [a, m] = await Promise.all([
      api<AccountPayload>("/api/account"),
      api<{ movements: Movement[] }>("/api/movements"),
    ]);
    if (!a.ok) {
      if (a.status === 401) {
        setAuthed(false);
        return;
      }
      setError(
        a.status === 429
          ? "Rate limit de Exness (429), reintentando en el próximo refresco…"
          : a.error,
      );
    } else {
      setAccount(a.data);
      if (a.data.positions) setPositions(a.data.positions);
      setError(null);
    }
    if (m.ok) setMovements(m.data.movements);
  }, []);

  useEffect(() => {
    if (!authed) return;
    void refresh();
    const id = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(id);
  }, [authed, refresh]);

  const persist = useCallback(() => {
    try {
      const payload: PersistedRobot = {
        strategy: strategyRef.current,
        log: logRef.current,
        lastError: lastErrorRef.current,
      };
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch {
      /* storage unavailable (private mode / quota): robot still runs in memory */
    }
  }, []);

  const commitStrategy = useCallback(
    (st: Strategy) => {
      strategyRef.current = st;
      setStrategy(st);
      persist();
    },
    [persist],
  );

  const pushLog = useCallback(
    (level: RobotLogEntry["level"], text: string) => {
      const entry: RobotLogEntry = {
        id: `l-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        at: new Date().toISOString(),
        level,
        text,
      };
      logRef.current = [entry, ...logRef.current].slice(0, LOG_MAX);
      setRobotLog(logRef.current);
      if (level === "error") {
        lastErrorRef.current = { at: entry.at, message: text };
        setLastError(lastErrorRef.current);
      }
      persist();
    },
    [persist],
  );

  // Restore robot state (running flag, config, managed position, log) after
  // reload / tab reopen. The browser is the source of truth, not the server.
  useEffect(() => {
    const saved = loadPersisted();
    if (saved) {
      const st = saved.strategy;
      strategyRef.current = st;
      setStrategy(st);
      logRef.current = saved.log;
      setRobotLog(saved.log);
      lastErrorRef.current = saved.lastError;
      setLastError(saved.lastError);
      setInstrument(st.instrument);
      setVolume(st.volume);
      setSide(st.side);
      setEntryMode(st.entryMode);
      setTrendForm(st.trend);
      setHoldTicks(st.holdTicks);
      setSlPct(st.slPct);
      setSlUsd(st.slUsd);
      setTpPct(st.tpPct);
      setTpUsd(st.tpUsd);
    }
    setHydrated(true);
  }, []);

  const running = strategy?.running === true;

  useEffect(() => {
    const id = setInterval(() => setClock(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);

  // Tick poller. The UI drives ticks (Hobby has no minute cron). Every tick
  // sends the full robot state, so server cold starts cannot stop the robot,
  // and tick errors only get logged and retried on the next tick.
  useEffect(() => {
    if (!hydrated || !authed || !running) {
      setTickHealth("idle");
      setNextTickAt(null);
      return;
    }

    let cancelled = false;
    let consecutiveFailures = 0;
    let consecutiveRateLimits = 0;

    const clearTimer = () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    const schedule = (ms: number) => {
      clearTimer();
      setNextTickAt(Date.now() + ms);
      timerRef.current = setTimeout(() => {
        void runTick();
      }, ms);
    };

    const failDelay = () =>
      Math.min(
        TICK_MAX_MS,
        Math.round(TICK_BASE_MS * Math.pow(1.4, consecutiveFailures)),
      );

    const rateLimitDelay = (retryAfterSec?: number) =>
      Math.min(
        RATE_LIMIT_MAX_MS,
        Math.max(
          RATE_LIMIT_MIN_MS * 2 ** Math.max(0, consecutiveRateLimits - 1),
          (retryAfterSec ?? 0) * 1000,
        ),
      );

    const runTick = async () => {
      if (cancelled || !strategyRef.current.running) return;
      if (tickLock.current) {
        schedule(2_000);
        return;
      }
      tickLock.current = true;
      setNextTickAt(null);
      const nowIso = new Date().toISOString();
      let delay = TICK_BASE_MS;
      try {
        const res = await api<TickResponse>("/api/strategy/tick", {
          method: "POST",
          body: JSON.stringify({ strategy: strategyRef.current }),
        });
        if (cancelled) return;
        if (res.ok) {
          const r = res.data;
          const wasRunning = strategyRef.current.running;
          commitStrategy({
            ...r.state,
            running: wasRunning,
            lastTickAt: nowIso,
          });
          for (const d of tickLogs(r)) pushLog(d.level, d.text);
          if (r.action === "rate_limited") {
            consecutiveRateLimits += 1;
            delay = rateLimitDelay(r.retryAfterSec);
            setTickHealth("ratelimit");
          } else if (r.action === "error") {
            consecutiveFailures += 1;
            delay = failDelay();
            setTickHealth("backoff");
          } else {
            consecutiveFailures = 0;
            consecutiveRateLimits = 0;
            setTickHealth("ok");
          }
        } else if (res.status === 401) {
          setAuthed(false);
          return;
        } else if (res.status === 429) {
          consecutiveRateLimits += 1;
          delay = rateLimitDelay(res.retryAfterSec);
          commitStrategy({
            ...strategyRef.current,
            lastTickAt: nowIso,
            lastAction: "rate_limit",
          });
          pushLog(
            "warn",
            `Rate limit de Exness (429), reintentando en ${Math.round(delay / 1000)}s`,
          );
          setTickHealth("ratelimit");
        } else {
          commitStrategy({
            ...strategyRef.current,
            lastTickAt: nowIso,
            tickCount: strategyRef.current.tickCount + 1,
            lastAction: "error",
            lastError: res.error,
          });
          pushLog("error", `Tick falló: ${res.error} (reintento automático)`);
          consecutiveFailures += 1;
          delay = failDelay();
          setTickHealth("backoff");
        }
        if (!cancelled) await refresh();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        commitStrategy({
          ...strategyRef.current,
          lastTickAt: nowIso,
          tickCount: strategyRef.current.tickCount + 1,
          lastAction: "error",
          lastError: msg,
        });
        pushLog("error", `Tick falló: ${msg} (reintento automático)`);
        consecutiveFailures += 1;
        delay = failDelay();
        setTickHealth("backoff");
      } finally {
        tickLock.current = false;
        if (!cancelled && strategyRef.current.running) schedule(delay);
      }
    };

    // First tick right away on Start; when resuming after a reload, respect the
    // time elapsed since the last tick.
    const last = strategyRef.current.lastTickAt
      ? Date.parse(strategyRef.current.lastTickAt)
      : NaN;
    const wait = Number.isFinite(last)
      ? Math.max(0, TICK_BASE_MS - (Date.now() - last))
      : 0;
    if (wait > 0) schedule(wait);
    else void runTick();

    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      const l = strategyRef.current.lastTickAt
        ? Date.parse(strategyRef.current.lastTickAt)
        : NaN;
      // Background tabs get throttled timers: catch up when the tab returns.
      if (!Number.isFinite(l) || Date.now() - l >= TICK_BASE_MS) {
        clearTimer();
        void runTick();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onVisibility);

    return () => {
      cancelled = true;
      clearTimer();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onVisibility);
    };
  }, [hydrated, authed, running, refresh, commitStrategy, pushLog]);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ secret }),
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setAuthed(true);
    setSecret("");
  }

  async function logout() {
    await api("/api/auth/logout", { method: "POST" });
    setAuthed(false);
    setAccount(null);
  }

  function setStrategyRunning(next: boolean) {
    const base = strategyRef.current;
    if (next) {
      const cfg = {
        instrument: instrument.trim().toUpperCase() || "BTCUSD",
        volume: volume.trim() || "0.01",
        side,
        entryMode,
        holdTicks: Math.max(1, Math.min(120, Number(holdTicks) || 10)),
        slPct: Math.max(0, Number(slPct) || 0),
        slUsd: Math.max(0, Number(slUsd) || 0),
        tpPct: Math.max(0, Number(tpPct) || 0),
        tpUsd: Math.max(0, Number(tpUsd) || 0),
        trend: sanitizeTrendParams(trendForm, base.trend),
      };
      const t0 = base.trend;
      const t1 = cfg.trend;
      const indicatorsChanged =
        t0.timeframeHours !== t1.timeframeHours ||
        t0.emaFast !== t1.emaFast ||
        t0.emaSlow !== t1.emaSlow ||
        t0.emaTrend !== t1.emaTrend ||
        t0.atrPeriod !== t1.atrPeriod ||
        t0.candleSource !== t1.candleSource ||
        base.instrument !== cfg.instrument;
      commitStrategy({
        ...base,
        ...cfg,
        trendRuntime: indicatorsChanged
          ? {
              ...base.trendRuntime,
              lastCandleTime: null,
              indicators: null,
              lastSignal: null,
              limits: null,
            }
          : base.trendRuntime,
        running: true,
        lastTickAt: null,
        lastAction: "start",
        status: base.managedPositionId ? "in_position" : "flat",
      });
      pushLog(
        "info",
        cfg.entryMode === "trend"
          ? `Robot iniciado: tendencia ${cfg.instrument} ${t1.timeframeHours}h, EMA ${t1.emaFast}/${t1.emaSlow}/${t1.emaTrend}, SL ${t1.slAtrMult}×ATR(${t1.atrPeriod}), TP ${t1.tpR ? `${t1.tpR}R` : "off"}${t1.trailing ? " + trailing" : ""}, riesgo ${t1.riskPct}%, cooldown ${t1.cooldownCandles} velas, pausa diaria ${t1.dailyLossPct}%`
          : `Robot iniciado (${cfg.instrument} ${cfg.volume}, SL ${cfg.slPct}%${cfg.slUsd ? ` / $${cfg.slUsd}` : ""}, TP ${cfg.tpPct || cfg.tpUsd ? `${cfg.tpPct}%${cfg.tpUsd ? ` / $${cfg.tpUsd}` : ""}` : "off"}, hold≤${cfg.holdTicks}, entry=${cfg.entryMode})`,
      );
    } else {
      commitStrategy({ ...base, running: false, lastAction: "stop" });
      pushLog("info", "Robot detenido manualmente (posiciones abiertas no se cierran)");
    }
  }

  async function manualOpen() {
    setBusy(true);
    const res = await api("/api/positions/open", {
      method: "POST",
      body: JSON.stringify({ instrument, side, volume }),
    });
    setBusy(false);
    if (!res.ok) setError(res.error);
    await refresh();
  }

  async function manualClose(positionId: string) {
    setBusy(true);
    const res = await api("/api/positions/close", {
      method: "POST",
      body: JSON.stringify({ positionId }),
    });
    setBusy(false);
    if (!res.ok) setError(res.error);
    await refresh();
  }

  if (!authed) {
    return (
      <div className="login-page">
        <div className="login-compose">
          <h1>
            Rodrigo
            <span> · Exness</span>
          </h1>
          <p>
            Acceso al panel demo. Introduce la clave compartida
            (<code>DASHBOARD_SECRET</code>).
          </p>
          <form onSubmit={handleLogin}>
            <input
              type="password"
              autoComplete="current-password"
              placeholder="Clave del dashboard"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              required
            />
            <button className="btn primary" type="submit" disabled={busy}>
              Entrar
            </button>
          </form>
          {error && <div className="error-banner">{error}</div>}
        </div>
      </div>
    );
  }

  const state = account?.accountState;
  const currency = state?.currency ? String(state.currency) : "";
  const robotLive = statusLabel(strategy);
  const isTrend = entryMode === "trend";
  const formLocked = strategy?.running || busy;
  const trendNum = (
    key: keyof TrendParams,
    label: string,
    step = 1,
    min = 0,
    max?: number,
  ) => (
    <div className="field" key={key}>
      <label htmlFor={`t-${key}`}>{label}</label>
      <input
        id={`t-${key}`}
        type="number"
        step={step}
        min={min}
        max={max}
        value={trendForm[key] as number}
        onChange={(e) => setTrendField(key, Number(e.target.value) as never)}
        disabled={formLocked}
      />
    </div>
  );

  return (
    <div className="shell">
      <div className="topbar">
        <span className="env">
          {account?.env ?? "demo"} · {account?.accountId ?? "…"}
        </span>
        <button className="btn ghost" type="button" onClick={() => void logout()}>
          Salir
        </button>
      </div>

      <header className="hero">
        <h1 className="brand">
          Rodrigo
          <span> · Exness</span>
        </h1>
        <p className="hero-lead">
          Panel demo con robot de seguir tendencia (BTC, velas cerradas, EMA +
          ATR, riesgo fijo por operación). Deja el panel abierto para que haga
          ticks (Hobby no tiene cron por minuto).
        </p>

        <div className="equity-block">
          <div className="equity-label">Equity {currency && `(${currency})`}</div>
          <div className="equity-value">{fmt(state?.equity)}</div>
          <div className="equity-meta">
            <div className="meta-item">
              <span className="k">Balance</span>
              <span className="v">{fmt(state?.balance)}</span>
            </div>
            <div className="meta-item">
              <span className="k">Margen</span>
              <span className="v">{fmt(state?.margin)}</span>
            </div>
            <div className="meta-item">
              <span className="k">Libre</span>
              <span className="v">{fmt(state?.freeMargin)}</span>
            </div>
            <div className="meta-item">
              <span className="k">Posiciones</span>
              <span className="v">{account?.openPositionCount ?? positions.length}</span>
            </div>
          </div>
          <div className="live-row">
            <span className={`live-dot ${account ? "" : "off"}`} />
            <span className="live-text">
              {account
                ? `Actualizado ${fmtTime(account.fetchedAt)} · poll 8s`
                : "Conectando…"}
            </span>
          </div>
        </div>
      </header>

      {error && <div className="error-banner">{error}</div>}

      <section className="section">
        <div className="section-head">
          <div>
            <h2>Posiciones abiertas</h2>
            <p>Libro vivo desde el snapshot de trading.</p>
          </div>
          <span className="section-note">{positions.length} abiertas</span>
        </div>
        {positions.length === 0 ? (
          <div className="empty">Sin posiciones abiertas.</div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Instrumento</th>
                <th>Lado</th>
                <th>Volumen</th>
                <th>Apertura</th>
                <th>PnL</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {positions.map((p) => {
                const pnl = p.profit != null ? Number(p.profit) : NaN;
                return (
                  <tr key={p.id ?? Math.random()}>
                    <td>{p.instrument ?? "—"}</td>
                    <td>
                      <span
                        className={`badge ${(p.side || "").toLowerCase() === "sell" ? "sell" : "buy"}`}
                      >
                        {p.side ?? "—"}
                      </span>
                    </td>
                    <td>{fmt(p.volume, 2)}</td>
                    <td>{fmt(p.openPrice, 2)}</td>
                    <td className={Number.isFinite(pnl) ? (pnl >= 0 ? "pos" : "neg") : ""}>
                      {fmt(p.profit)}
                    </td>
                    <td>
                      {p.id && (
                        <button
                          className="btn danger"
                          type="button"
                          disabled={busy}
                          onClick={() => void manualClose(p.id!)}
                        >
                          Cerrar
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <section className="section">
        <div className="section-head">
          <div>
            <h2>Robot automático</h2>
            <p>
              {isTrend
                ? "Seguir tendencia: evalúa solo al cerrar cada vela. Compra si EMA rápida cruza sobre la lenta y precio > EMA de tendencia (venta al revés); una posición a la vez; SL en ATR, TP en R, frenos de pérdida diaria / cooldown / spread."
                : "Modo legacy: si flat → open mercado (alternate / random / fixed). Luego cierra por SL %, TP opcional o timeout de ticks. Sin ventaja estadística — solo demo."}
            </p>
          </div>
          <span
            className={`section-note robot-badge ${running ? "on" : ""}`}
          >
            {running ? "ROBOT ON" : "ROBOT OFF"} · {robotLive}
          </span>
        </div>

        <div className="controls">
          <div className="field">
            <label htmlFor="instrument">Instrumento</label>
            <input
              id="instrument"
              value={instrument}
              onChange={(e) => setInstrument(e.target.value.toUpperCase())}
              disabled={strategy?.running || busy}
            />
          </div>
          {!isTrend && (
            <div className="field">
              <label htmlFor="volume">Volumen</label>
              <input
                id="volume"
                value={volume}
                onChange={(e) => setVolume(e.target.value)}
                disabled={strategy?.running || busy}
              />
            </div>
          )}
          <div className="field">
            <label htmlFor="entryMode">Entrada</label>
            <select
              id="entryMode"
              value={entryMode}
              onChange={(e) => setEntryMode(e.target.value as Strategy["entryMode"])}
              disabled={strategy?.running || busy}
            >
              <option value="trend">trend (seguir tendencia)</option>
              <option value="alternate">alternate</option>
              <option value="random">random</option>
              <option value="fixed">fixed</option>
            </select>
          </div>
          {isTrend && (
            <>
              <div className="field">
                <label htmlFor="t-tf">Timeframe</label>
                <select
                  id="t-tf"
                  value={trendForm.timeframeHours}
                  onChange={(e) =>
                    setTrendField("timeframeHours", Number(e.target.value) === 4 ? 4 : 1)
                  }
                  disabled={formLocked}
                >
                  <option value={1}>1h</option>
                  <option value={4}>4h (mejor en backtest)</option>
                </select>
              </div>
              {trendNum("emaFast", "EMA rápida", 1, 2, 300)}
              {trendNum("emaSlow", "EMA lenta", 1, 3, 400)}
              {trendNum("emaTrend", "EMA tendencia", 1, 5, 600)}
              {trendNum("atrPeriod", "ATR período", 1, 2, 100)}
              {trendNum("slAtrMult", "SL × ATR", 0.1, 0.3, 10)}
              {trendNum("tpR", "TP (R, 0=off)", 0.5, 0, 10)}
              <div className="field">
                <label htmlFor="t-trailing">Trailing</label>
                <select
                  id="t-trailing"
                  value={trendForm.trailing ? "on" : "off"}
                  onChange={(e) => setTrendField("trailing", e.target.value === "on")}
                  disabled={formLocked}
                >
                  <option value="off">off</option>
                  <option value="on">on</option>
                </select>
              </div>
              {trendNum("trailActivateR", "Trailing desde (R)", 0.5, 0, 10)}
              {trendNum("trailAtrMult", "Trailing × ATR", 0.1, 0.3, 10)}
              {trendNum("riskPct", "Riesgo % equity", 0.1, 0.05, 2)}
              {trendNum("maxVolume", "Volumen máx. (lotes)", 0.01, 0.001, 1000)}
              {trendNum("maxSpreadPct", "Spread máx. % (0=off)", 0.01, 0, 5)}
              {trendNum("cooldownCandles", "Cooldown (velas)", 1, 0, 48)}
              {trendNum("dailyLossPct", "Pausa pérdida día %", 0.5, 0.5, 20)}
              <div className="field">
                <label htmlFor="t-source">Fuente de velas</label>
                <select
                  id="t-source"
                  value={trendForm.candleSource}
                  onChange={(e) =>
                    setTrendField("candleSource", e.target.value as TrendParams["candleSource"])
                  }
                  disabled={formLocked}
                >
                  {CANDLE_SOURCES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
            </>
          )}
          {!isTrend && (
            <>
          <div className="field">
            <label htmlFor="side">Lado (fixed)</label>
            <select
              id="side"
              value={side}
              onChange={(e) => setSide(e.target.value as "buy" | "sell")}
              disabled={strategy?.running || busy || entryMode !== "fixed"}
            >
              <option value="buy">buy</option>
              <option value="sell">sell</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="slPct">SL %</label>
            <input
              id="slPct"
              type="number"
              step="0.1"
              min="0"
              value={slPct}
              onChange={(e) => setSlPct(Number(e.target.value))}
              disabled={strategy?.running || busy}
            />
          </div>
          <div className="field">
            <label htmlFor="slUsd">SL $ (opc.)</label>
            <input
              id="slUsd"
              type="number"
              step="0.5"
              min="0"
              value={slUsd}
              onChange={(e) => setSlUsd(Number(e.target.value))}
              disabled={strategy?.running || busy}
            />
          </div>
          <div className="field">
            <label htmlFor="tpPct">TP % (opc.)</label>
            <input
              id="tpPct"
              type="number"
              step="0.1"
              min="0"
              value={tpPct}
              onChange={(e) => setTpPct(Number(e.target.value))}
              disabled={strategy?.running || busy}
            />
          </div>
          <div className="field">
            <label htmlFor="tpUsd">TP $ (opc.)</label>
            <input
              id="tpUsd"
              type="number"
              step="0.5"
              min="0"
              value={tpUsd}
              onChange={(e) => setTpUsd(Number(e.target.value))}
              disabled={strategy?.running || busy}
            />
          </div>
          <div className="field">
            <label htmlFor="holdTicks">Max hold ticks</label>
            <input
              id="holdTicks"
              type="number"
              min="1"
              max="120"
              value={holdTicks}
              onChange={(e) => setHoldTicks(Number(e.target.value))}
              disabled={strategy?.running || busy}
            />
          </div>
            </>
          )}
          {strategy?.running ? (
            <button
              className="btn danger"
              type="button"
              disabled={busy}
              onClick={() => setStrategyRunning(false)}
            >
              Stop robot
            </button>
          ) : (
            <button
              className="btn primary"
              type="button"
              disabled={busy}
              onClick={() => setStrategyRunning(true)}
            >
              Start robot
            </button>
          )}
          <button
            className="btn"
            type="button"
            disabled={busy}
            onClick={() => void manualOpen()}
          >
            Open manual
          </button>
        </div>

        {strategy && (
          <>
            <div className={`robot-state ${running ? "on" : "off"}`}>
              <div className="robot-state-main">
                <span className="robot-dot" aria-hidden />
                <strong>{running ? "CORRIENDO" : "DETENIDO"}</strong>
                <span className="robot-state-sub">
                  {running
                    ? tickHealth === "ratelimit"
                      ? "rate limit, reintentando"
                      : tickHealth === "backoff"
                        ? "reintentando tras error"
                        : "activo mientras esta pestaña esté abierta"
                    : "pulsa Start robot para iniciar"}
                </span>
              </div>
              <div className="robot-state-grid">
                <span>
                  último tick:{" "}
                  <strong>
                    {strategy.lastTickAt ? fmtTime(strategy.lastTickAt) : "—"}
                  </strong>
                </span>
                <span>
                  próximo tick:{" "}
                  <strong>
                    {running && nextTickAt ? fmtTime(new Date(nextTickAt).toISOString()) : "—"}
                  </strong>
                </span>
                <span>
                  última acción: <strong>{strategy.lastAction ?? "—"}</strong>
                </span>
                <span className={lastError ? "neg" : ""}>
                  último error:{" "}
                  <strong>
                    {lastError
                      ? `${fmtTime(lastError.at)} · ${lastError.message}`
                      : "—"}
                  </strong>
                </span>
              </div>
            </div>
            {strategy.entryMode === "trend" && (() => {
              const rt = strategy.trendRuntime;
              const tp = strategy.trend;
              const tfMs = tp.timeframeHours * HOUR_MS;
              const ind = rt.indicators;
              const eq = rt.equity ?? (state?.equity != null ? Number(state.equity) : null);
              const next = rt.nextEvalAt ?? nextEvalTime(clock, tp);
              const nextShown = Math.max(next, nextEvalTime(clock, tp));
              const cdLeft =
                rt.lastCandleTime != null
                  ? Math.max(0, Math.ceil((rt.cooldownUntil - rt.lastCandleTime - tfMs) / tfMs))
                  : 0;
              const bias = ind
                ? ind.close > ind.emaTrend && ind.emaFast > ind.emaSlow
                  ? "alcista"
                  : ind.close < ind.emaTrend && ind.emaFast < ind.emaSlow
                    ? "bajista"
                    : "mixta / sin tendencia clara"
                : "—";
              const sig = rt.lastSignal;
              const pos = rt.pos;
              const cell = (k: string, v: React.ReactNode, cls = "") => (
                <div className={`trend-cell ${cls}`}>
                  <span className="k">{k}</span>
                  <span className="v">{v}</span>
                </div>
              );
              return (
                <div className="trend-grid">
                  {cell(`EMA ${tp.emaFast}`, ind ? fmt(ind.emaFast) : "—")}
                  {cell(`EMA ${tp.emaSlow}`, ind ? fmt(ind.emaSlow) : "—")}
                  {cell(`EMA ${tp.emaTrend}`, ind ? fmt(ind.emaTrend) : "—")}
                  {cell(`ATR ${tp.atrPeriod}`, ind ? fmt(ind.atr) : "—")}
                  {cell(
                    "Última vela",
                    ind
                      ? `${new Date(ind.t).toISOString().slice(5, 16).replace("T", " ")}Z · ${fmt(ind.close)} · ${ind.source}`
                      : "—",
                  )}
                  {cell("Sesgo", bias)}
                  {cell(
                    "Última señal",
                    sig
                      ? `${sig.side ? sig.side.toUpperCase() : "ninguna"} · vela ${new Date(sig.candleTime).toISOString().slice(5, 16).replace("T", " ")}Z`
                      : "—",
                    sig?.side === "buy" ? "pos" : sig?.side === "sell" ? "neg" : "",
                  )}
                  {cell(
                    "Próxima evaluación",
                    new Date(nextShown).toLocaleString("es-ES", {
                      day: "2-digit",
                      month: "2-digit",
                      hour: "2-digit",
                      minute: "2-digit",
                    }),
                  )}
                  {cell(
                    "Riesgo por operación",
                    `${tp.riskPct}%${eq != null ? ` ≈ $${fmt((eq * tp.riskPct) / 100)}` : ""}${rt.riskUsd != null ? ` (última: $${fmt(rt.riskUsd)})` : ""}`,
                  )}
                  {cell(
                    "PnL del día (UTC)",
                    rt.dayPnl != null
                      ? `${rt.dayPnl >= 0 ? "+" : ""}${fmt(rt.dayPnl)} (${fmt(rt.dayPnlPct ?? 0)}%) · límite -${tp.dailyLossPct}%`
                      : "—",
                    rt.dayPnl != null ? (rt.dayPnl >= 0 ? "pos" : "neg") : "",
                  )}
                  {cell(
                    "Freno: pérdida diaria",
                    rt.dayPaused ? "PAUSA hasta 00:00 UTC" : "ok",
                    rt.dayPaused ? "neg" : "",
                  )}
                  {cell(
                    "Freno: cooldown",
                    cdLeft > 0 ? `${cdLeft} vela(s) restantes` : "ok",
                    cdLeft > 0 ? "neg" : "",
                  )}
                  {cell(
                    "Freno: spread",
                    rt.lastSpread != null
                      ? `${fmt(rt.lastSpread)} (${fmt(rt.lastSpreadPct ?? 0, 3)}%) · máx ${tp.maxSpreadPct ? `${tp.maxSpreadPct}%` : "off"}`
                      : `sin dato · máx ${tp.maxSpreadPct ? `${tp.maxSpreadPct}%` : "off"}`,
                  )}
                  {cell(
                    "Posición",
                    pos
                      ? `${pos.side.toUpperCase()} ${pos.vol} @ ${fmt(pos.entry)} · SL ${fmt(pos.sl)}${pos.tp != null ? ` · TP ${fmt(pos.tp)}` : ""}${pos.trailActive ? " (trailing)" : ""} · ${pos.brokerStops ? "SL/TP en broker" : "SL/TP vigilados"}`
                      : "flat",
                  )}
                </div>
              );
            })()}
            <div className="strategy-status">
              <span>
                estado: <strong>{robotLive}</strong>
              </span>
              <span>ticks: {strategy.tickCount}</span>
              {strategy.entryMode !== "trend" && (
                <>
                  <span>
                    hold: {strategy.ticksSinceOpen}/{strategy.holdTicks}
                  </span>
                  <span>
                    SL {strategy.slPct}%
                    {strategy.slUsd > 0 ? ` / $${strategy.slUsd}` : ""}
                  </span>
                  <span>
                    TP{" "}
                    {strategy.tpPct > 0 || strategy.tpUsd > 0
                      ? `${strategy.tpPct}%${strategy.tpUsd > 0 ? ` / $${strategy.tpUsd}` : ""}`
                      : "off"}
                  </span>
                </>
              )}
              <span>modo: {strategy.entryMode}</span>
              <span>pos: {strategy.managedPositionId ?? "—"}</span>
              <span>
                open@: {strategy.openPrice != null ? fmt(strategy.openPrice) : "—"}
              </span>
              <span>last close: {strategy.lastCloseReason ?? "—"}</span>
              <span>
                poll:{" "}
                {tickHealth === "ok"
                  ? "~35s"
                  : tickHealth === "ratelimit"
                    ? "rate limit (429)"
                    : tickHealth === "backoff"
                      ? "backoff"
                      : "idle"}
              </span>
            </div>
          </>
        )}

        <div className="robot-log">
          <h3>Log del robot</h3>
          {robotLog.length === 0 ? (
            <div className="empty">Sin eventos todavía.</div>
          ) : (
            <ul>
              {robotLog.map((l) => (
                <li key={l.id} className={`log-${l.level}`}>
                  <time dateTime={l.at}>{fmtTime(l.at)}</time>
                  <span>{l.text}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <div>
            <h2>Movimientos recientes</h2>
            <p>
              Opens/closes del robot con razón <code>sl</code> · <code>tp</code>{" "}
              · <code>trail</code> · <code>cross</code> · <code>broker</code> · <code>timeout</code> (memoria del servidor; el log del robot de arriba persiste en este navegador).
            </p>
          </div>
        </div>
        {movements.length === 0 ? (
          <div className="empty">Aún no hay operaciones registradas en esta sesión.</div>
        ) : (
          <ul className="movements">
            {movements.map((m) => (
              <li key={m.id}>
                <time dateTime={m.at}>{fmtTime(m.at)}</time>
                <div>
                  <span className="kind">{m.kind}</span>
                  {m.reason && (
                    <span className={`reason-tag reason-${m.reason}`}>
                      {m.reason}
                    </span>
                  )}
                  {m.message}
                  {m.instrument ? ` · ${m.instrument}` : ""}
                  {m.pnl != null ? ` · pnl ${fmt(m.pnl)}` : ""}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
