"use client";

import { useCallback, useEffect, useRef, useState } from "react";

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
  reason?: "sl" | "tp" | "timeout";
};

type Strategy = {
  running: boolean;
  instrument: string;
  volume: string;
  side: "buy" | "sell";
  entryMode: "alternate" | "random" | "fixed";
  holdTicks: number;
  slPct: number;
  slUsd: number;
  tpPct: number;
  tpUsd: number;
  ticksSinceOpen: number;
  managedPositionId: string | null;
  managedSide: "buy" | "sell" | null;
  openPrice: number | null;
  lastTickAt: string | null;
  lastError: string | null;
  lastAction: string | null;
  lastCloseReason: "sl" | "tp" | "timeout" | null;
  status: "flat" | "in_position" | "opening" | "closing";
  tickCount: number;
};

const TICK_BASE_MS = 35_000;
const TICK_MAX_MS = 120_000;

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

async function api<T>(
  path: string,
  init?: RequestInit,
): Promise<{ ok: true; data: T } | { ok: false; status: number; error: string }> {
  const res = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
  const json = await res.json().catch(() => ({}));
  if (res.status === 401) {
    return { ok: false, status: 401, error: "No autorizado" };
  }
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      error: (json as { error?: string }).error || `HTTP ${res.status}`,
    };
  }
  return { ok: true, data: json as T };
}

export function Dashboard({ needsAuth }: { needsAuth: boolean }) {
  const [account, setAccount] = useState<AccountPayload | null>(null);
  const [positions, setPositions] = useState<Position[]>([]);
  const [movements, setMovements] = useState<Movement[]>([]);
  const [strategy, setStrategy] = useState<Strategy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [instrument, setInstrument] = useState("BTCUSD");
  const [volume, setVolume] = useState("0.01");
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [entryMode, setEntryMode] = useState<"alternate" | "random" | "fixed">(
    "alternate",
  );
  const [holdTicks, setHoldTicks] = useState(10);
  const [slPct, setSlPct] = useState(0.3);
  const [slUsd, setSlUsd] = useState(0);
  const [tpPct, setTpPct] = useState(0);
  const [tpUsd, setTpUsd] = useState(0);
  const [secret, setSecret] = useState("");
  const [authed, setAuthed] = useState(!needsAuth);
  const [tickHealth, setTickHealth] = useState<"ok" | "backoff" | "idle">(
    "idle",
  );
  const tickLock = useRef(false);
  const backoffMs = useRef(TICK_BASE_MS);
  const runningRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    const [a, p, m, s] = await Promise.all([
      api<AccountPayload>("/api/account"),
      api<{ positions: Position[] }>("/api/positions"),
      api<{ movements: Movement[] }>("/api/movements"),
      api<{ strategy: Strategy }>("/api/strategy"),
    ]);
    if (!a.ok) {
      if (a.status === 401) {
        setAuthed(false);
        return;
      }
      setError(a.error);
    } else {
      setAccount(a.data);
      setError(null);
    }
    if (p.ok) setPositions(p.data.positions);
    if (m.ok) setMovements(m.data.movements);
    if (s.ok) {
      const st = s.data.strategy;
      setStrategy(st);
      runningRef.current = st.running;
      if (!st.running) {
        setInstrument(st.instrument || "BTCUSD");
        setVolume(st.volume || "0.01");
        setSide(st.side || "buy");
        setEntryMode(st.entryMode || "alternate");
        setHoldTicks(st.holdTicks ?? 10);
        setSlPct(st.slPct ?? 0.3);
        setSlUsd(st.slUsd ?? 0);
        setTpPct(st.tpPct ?? 0);
        setTpUsd(st.tpUsd ?? 0);
      }
    }
  }, []);

  useEffect(() => {
    if (!authed) return;
    void refresh();
    const id = setInterval(() => void refresh(), 8_000);
    return () => clearInterval(id);
  }, [authed, refresh]);

  // Strategy tick poller — UI drives ticks when running (Hobby-safe).
  // Visibility-aware + exponential backoff on errors.
  useEffect(() => {
    if (!authed || !strategy?.running) {
      runningRef.current = false;
      setTickHealth("idle");
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      return;
    }

    runningRef.current = true;
    let cancelled = false;
    backoffMs.current = TICK_BASE_MS;

    const clearTimer = () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    const schedule = (ms: number) => {
      clearTimer();
      timerRef.current = setTimeout(() => {
        void runTick();
      }, ms);
    };

    const runTick = async () => {
      if (cancelled || !runningRef.current) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        setTickHealth("backoff");
        schedule(TICK_BASE_MS);
        return;
      }
      if (tickLock.current) {
        schedule(2_000);
        return;
      }
      tickLock.current = true;
      try {
        const res = await api("/api/strategy/tick", { method: "POST" });
        if (!res.ok) {
          backoffMs.current = Math.min(
            TICK_MAX_MS,
            Math.round(backoffMs.current * 1.6),
          );
          setTickHealth("backoff");
          setError(res.error);
        } else {
          backoffMs.current = TICK_BASE_MS;
          setTickHealth("ok");
        }
        await refresh();
      } catch (err) {
        backoffMs.current = Math.min(
          TICK_MAX_MS,
          Math.round(backoffMs.current * 1.6),
        );
        setTickHealth("backoff");
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        tickLock.current = false;
        if (!cancelled && runningRef.current) {
          schedule(backoffMs.current);
        }
      }
    };

    // Immediate first tick when Start / effect mounts
    void runTick();

    const onVisibility = () => {
      if (document.visibilityState === "visible" && runningRef.current) {
        backoffMs.current = TICK_BASE_MS;
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
  }, [authed, strategy?.running, refresh]);

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

  async function setStrategyRunning(running: boolean) {
    setBusy(true);
    const res = await api<{ strategy: Strategy }>("/api/strategy", {
      method: "POST",
      body: JSON.stringify({
        running,
        instrument,
        volume,
        side,
        entryMode,
        holdTicks,
        slPct,
        slUsd,
        tpPct,
        tpUsd,
      }),
    });
    setBusy(false);
    if (res.ok) {
      setStrategy(res.data.strategy);
      runningRef.current = res.data.strategy.running;
      await refresh();
    } else setError(res.error);
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
          Panel demo con robot automático: abre/cierra sin clics, con stop loss
          simple y take profit opcional. Deja el panel abierto para que haga
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
              Si flat → open mercado (lado alternate / random / fixed). Luego
              cierra por SL, TP opcional o timeout de ticks. No está optimizado —
              solo inventable para demo.
            </p>
          </div>
          <span
            className={`section-note robot-badge ${strategy?.running ? "on" : ""}`}
          >
            {strategy?.running ? "ROBOT ON" : "ROBOT OFF"} · {robotLive}
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
          <div className="field">
            <label htmlFor="volume">Volumen</label>
            <input
              id="volume"
              value={volume}
              onChange={(e) => setVolume(e.target.value)}
              disabled={strategy?.running || busy}
            />
          </div>
          <div className="field">
            <label htmlFor="entryMode">Entrada</label>
            <select
              id="entryMode"
              value={entryMode}
              onChange={(e) =>
                setEntryMode(e.target.value as "alternate" | "random" | "fixed")
              }
              disabled={strategy?.running || busy}
            >
              <option value="alternate">alternate</option>
              <option value="random">random</option>
              <option value="fixed">fixed</option>
            </select>
          </div>
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
          {strategy?.running ? (
            <button
              className="btn danger"
              type="button"
              disabled={busy}
              onClick={() => void setStrategyRunning(false)}
            >
              Stop robot
            </button>
          ) : (
            <button
              className="btn primary"
              type="button"
              disabled={busy}
              onClick={() => void setStrategyRunning(true)}
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
          <div className="strategy-status">
            <span>
              estado: <strong>{robotLive}</strong>
            </span>
            <span>ticks: {strategy.tickCount}</span>
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
            <span>pos: {strategy.managedPositionId ?? "—"}</span>
            <span>
              open@: {strategy.openPrice != null ? fmt(strategy.openPrice) : "—"}
            </span>
            <span>
              last action: {strategy.lastAction ?? "—"}
            </span>
            <span>
              last close: {strategy.lastCloseReason ?? "—"}
            </span>
            <span>
              last tick:{" "}
              {strategy.lastTickAt ? fmtTime(strategy.lastTickAt) : "—"}
            </span>
            <span>
              poll:{" "}
              {tickHealth === "ok"
                ? "~35s"
                : tickHealth === "backoff"
                  ? "backoff / tab oculta"
                  : "idle"}
            </span>
            {strategy.lastError && (
              <span className="neg">err: {strategy.lastError}</span>
            )}
          </div>
        )}
      </section>

      <section className="section">
        <div className="section-head">
          <div>
            <h2>Movimientos recientes</h2>
            <p>
              Opens/closes del robot con razón <code>sl</code> · <code>tp</code>{" "}
              · <code>timeout</code> (memoria del proceso).
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
