# Exness Trading Dashboard (Next.js · Vercel)

Panel web **demo** para la cuenta de trading Exness de Rodrigo: balance/equity, posiciones, movimientos y un **robot automático** (open → monitor SL/TP/timeout → close).

Toda la firma Ed25519 (`EXN-*`) y las llamadas a Exness viven **solo en Route Handlers** (server-side). El navegador nunca ve `EXN_PRIVATE_KEY`.

> Port TypeScript del cliente en `docs/exness-demo-bot/`. No MetaTrader.

## Requisitos

- Node 20+
- Cuenta Exness Trading (API, no MT) con keys **demo**
- Gateway del DNS widget en Key Management

## Variables de entorno

Copia `.env.example` → `.env.local` (local) o configúralas en Vercel:

| Variable | Obligatoria | Descripción |
|---|---|---|
| `EXN_API_KEY` | sí | Public key id (`exnsk-…`) |
| `EXN_PRIVATE_KEY` | sí | Ed25519 private (128 hex o PEM) |
| `EXN_ACCOUNT_ID` | sí | Account id |
| `EXN_DISCOVERY_BASE_URL` | sí | Gateway (p. ej. `https://api.exness.com`) |
| `EXNESS_ENV` | no | `demo` (default). **`live` se rechaza** sin `EXNESS_ALLOW_LIVE=yes` |
| `EXNESS_ALLOW_LIVE` | no | Solo si intencionas live (`yes` / `true` / `1`) |
| `DASHBOARD_SECRET` | recomendada | Clave compartida del panel (cookie + header `x-dashboard-secret`) |
| `EXNESS_INSTRUMENT` | no | Default `BTCUSD` |
| `EXNESS_VOLUME` | no | Default `0.01` |
| `EXNESS_SIDE` | no | Default `buy` (usado si `entryMode=fixed`) |
| `EXNESS_ENTRY_MODE` | no | `alternate` (default) · `random` · `fixed` |
| `EXNESS_HOLD_TICKS` | no | Max ticks en posición antes de `timeout` (default `10`) |
| `EXNESS_SL_PCT` | no | Stop loss en % del precio de apertura (default `0.3`) |
| `EXNESS_SL_USD` | no | Stop loss fijo en $ de PnL no realizado (opcional) |
| `EXNESS_TP_PCT` | no | Take profit en % (opcional, `0` = off) |
| `EXNESS_TP_USD` | no | Take profit fijo en $ (opcional) |
| `CRON_SECRET` | Vercel | Auto en Vercel Pro para `/api/cron/tick` |

**Nunca** uses prefijos `NEXT_PUBLIC_` para secrets. No loguear `EXN-DATA` / `EXN-SIGN` / private key.

## Local

```bash
npm install
cp .env.example .env.local   # rellena DEMO keys + DASHBOARD_SECRET
npm run verify:signing       # vector oficial offline
npm run dev                  # http://localhost:3000
```

## Robot automático (serverless / Hobby)

En Vercel **no** hay un proceso forever y **Hobby no permite cron cada minuto**. El bucle es:

1. En el panel: configura instrumento / volumen / SL / TP → **Start robot**.
2. Eso hace `POST /api/strategy` con `{ running: true, slPct, tpPct, … }`.
3. El cliente hace poll fiable a `POST /api/strategy/tick` (~35s) mientras `running`:
   - tick inmediato al Start y al volver a la pestaña (`visibilitychange` / `focus`)
   - backoff exponencial si el tick falla (hasta ~120s)
   - no dispara ticks con la pestaña oculta (reprograma al volver)
4. **Deja el dashboard abierto** mientras quieras que el robot opere. Si cierras la pestaña, los ticks paran (estado in-memory también puede perderse en cold start).
5. En **Pro**, puedes reactivar cron minuto en `vercel.json` hacia `GET /api/cron/tick` (auth `CRON_SECRET`) como respaldo.

### Lógica inventable (no optimizada)

Cada tick:

- **Flat** → abre mercado en BTCUSD (u otro instrumento): lado `alternate` / `random` / `fixed`.
- **En posición** → mira precio vs `open_price` y PnL no realizado:
  - **sl** si el movimiento ≤ `−slPct` o PnL ≤ `−slUsd`
  - **tp** si el movimiento ≥ `tpPct` o PnL ≥ `tpUsd` (opcionales)
  - **timeout** si `ticksSinceOpen ≥ holdTicks`
- El log de movimientos marca la razón (`sl` | `tp` | `timeout`).

Estado de estrategia y log: **in-memory** por isolate. Un cold start reinicia `running=false` y vacía el log. Para producción seria: KV / DB.

## Auth del dashboard

- Si `DASHBOARD_SECRET` está definido, la home pide la clave y setea cookie httpOnly.
- APIs también aceptan header `x-dashboard-secret: <valor>`.
- Cron usa `Authorization: Bearer $CRON_SECRET`.

## APIs

| Método | Ruta | Uso |
|---|---|---|
| POST | `/api/auth/login` | `{ secret }` → cookie |
| POST | `/api/auth/logout` | limpia cookie |
| GET | `/api/account` | balance / equity / margin |
| GET | `/api/positions` | posiciones abiertas |
| POST | `/api/positions/open` | open manual |
| POST | `/api/positions/close` | `{ positionId }` |
| GET | `/api/movements` | log reciente |
| GET/POST | `/api/strategy` | leer / start-stop + config (SL/TP/volume/instrument) |
| POST | `/api/strategy/tick` | un paso del robot |
| GET | `/api/cron/tick` | cron Vercel (opcional Pro) |

### `POST /api/strategy` body

```json
{
  "running": true,
  "instrument": "BTCUSD",
  "volume": "0.01",
  "side": "buy",
  "entryMode": "alternate",
  "holdTicks": 10,
  "slPct": 0.3,
  "slUsd": 0,
  "tpPct": 0,
  "tpUsd": 0
}
```

Campos omitidos conservan el estado actual / defaults de env.

## Deploy en Vercel — cómo arranca Rodrigo el robot

1. Repo `rodrigog84/exness-dashboard` importado en Vercel (Root Directory `.`).
2. Environment Variables (Production):
   - `EXN_API_KEY`, `EXN_PRIVATE_KEY`, `EXN_ACCOUNT_ID`, `EXN_DISCOVERY_BASE_URL`
   - `EXNESS_ENV=demo` (no pongas `live` sin `EXNESS_ALLOW_LIVE=yes`)
   - `DASHBOARD_SECRET=<tu clave>`
   - Opcional: `EXNESS_SL_PCT=0.3`, `EXNESS_HOLD_TICKS=10`, `EXNESS_VOLUME=0.01`
3. Deploy → abre la URL del proyecto.
4. Login con `DASHBOARD_SECRET`.
5. En **Robot automático**: revisa SL % / TP / max hold → pulsa **Start robot**.
6. **Deja la pestaña abierta** — el poll de la UI (~35s) es el motor en Hobby. Verás estado `flat` / `en posición` y closes con razón `sl|tp|timeout` en Movimientos.
7. **Stop robot** para detener (no cierra una posición ya abierta; usa Cerrar manual si hace falta).

### Cron (solo Pro)

Hobby: sin cron en `vercel.json`. Pro puede añadir:

```json
{
  "crons": [{ "path": "/api/cron/tick", "schedule": "*/1 * * * *" }]
}
```

## Seguridad

- Solo demo por defecto; **`EXNESS_ENV=live` sin `EXNESS_ALLOW_LIVE` lanza error de config** y no opera.
- Firma Ed25519 en Node (`crypto`); redirects desactivados.
- Access Point cacheado en el isolate (discovery rate-limited).
- Forex puede devolver `trading_disabled` en fin de semana; BTCUSD suele operar.

## Estructura

```
app/                 App Router pages + Route Handlers
components/          Dashboard UI (ES) — Start/Stop robot + poll fiable
lib/exness/          Cliente + firma (port del bot Python)
lib/strategy.ts      Robot: open/close + SL/TP/timeout
lib/auth.ts          Cookie / secret gate
vercel.json          (vacío en Hobby; Pro puede reactivar cron)
scripts/verify-signing.ts
```
