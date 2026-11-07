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
};

type Strategy = {
  running: boolean;
  instrument: string;
  volume: string;
  side: "buy" | "sell";
  holdTicks: number;
  ticksSinceOpen: number;
  managedPositionId: string | null;
  lastTickAt: string | null;
  lastError: string | null;
  tickCount: number;
};

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
  const [secret, setSecret] = useState("");
  const [authed, setAuthed] = useState(!needsAuth);
  const tickLock = useRef(false);

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
      setStrategy(s.data.strategy);
      setInstrument(s.data.strategy.instrument || "BTCUSD");
      setVolume(s.data.strategy.volume || "0.01");
      setSide(s.data.strategy.side || "buy");
    }
  }, []);

  useEffect(() => {
    if (!authed) return;
    void refresh();
    const id = setInterval(() => void refresh(), 8_000);
    return () => clearInterval(id);
  }, [authed, refresh]);

  // Strategy tick poller — UI drives ticks when running (serverless-safe).
  useEffect(() => {
    if (!authed || !strategy?.running) return;
    const id = setInterval(async () => {
      if (tickLock.current) return;
      tickLock.current = true;
      try {
        await api("/api/strategy/tick", { method: "POST" });
        await refresh();
      } finally {
        tickLock.current = false;
      }
    }, 35_000);
    return () => clearInterval(id);
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
        holdTicks: strategy?.holdTicks ?? 3,
      }),
    });
    setBusy(false);
    if (res.ok) {
      setStrategy(res.data.strategy);
      if (running) {
        // Immediate first tick
        await api("/api/strategy/tick", { method: "POST" });
      }
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
          Panel demo de trading: equity en vivo, posiciones abiertas y un
          bucle de estrategia mínimo para probar open/close.
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
            <h2>Estrategia placeholder</h2>
            <p>
              Tick serverless: abre un lote mínimo, espera N ticks, cierra.
              No está optimizada — solo prueba el bucle.
            </p>
          </div>
          <span className="section-note">
            {strategy?.running ? "RUNNING" : "STOPPED"}
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
            <label htmlFor="side">Lado</label>
            <select
              id="side"
              value={side}
              onChange={(e) => setSide(e.target.value as "buy" | "sell")}
              disabled={strategy?.running || busy}
            >
              <option value="buy">buy</option>
              <option value="sell">sell</option>
            </select>
          </div>
          {strategy?.running ? (
            <button
              className="btn danger"
              type="button"
              disabled={busy}
              onClick={() => void setStrategyRunning(false)}
            >
              Detener
            </button>
          ) : (
            <button
              className="btn primary"
              type="button"
              disabled={busy}
              onClick={() => void setStrategyRunning(true)}
            >
              Iniciar
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
            <span>ticks: {strategy.tickCount}</span>
            <span>
              hold: {strategy.ticksSinceOpen}/{strategy.holdTicks}
            </span>
            <span>pos: {strategy.managedPositionId ?? "—"}</span>
            <span>
              last:{" "}
              {strategy.lastTickAt ? fmtTime(strategy.lastTickAt) : "—"}
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
            <p>Opens, closes y eventos de estrategia (memoria del proceso).</p>
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
                  {m.message}
                  {m.instrument ? ` · ${m.instrument}` : ""}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
