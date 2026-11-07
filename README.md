# Exness Trading Dashboard (Next.js · Vercel)

Panel web **demo** para la cuenta de trading Exness de Rodrigo: balance/equity, posiciones, movimientos y un **robot automático de seguir tendencia** (velas cerradas de BTCUSD, EMA + ATR, riesgo fijo por operación). Los modos antiguos (alternate / random / fixed) siguen disponibles como opción.

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
| `EXNESS_ENTRY_MODE` | no | `trend` (default) · `alternate` · `random` · `fixed` |
| `EXNESS_HOLD_TICKS` | no | Solo modos legacy: max ticks en posición antes de `timeout` (default `10`) |
| `EXNESS_SL_PCT` | no | Solo legacy: stop loss en % del precio de apertura (default `0.3`) |
| `EXNESS_SL_USD` | no | Solo legacy: stop loss fijo en $ de PnL no realizado (opcional) |
| `EXNESS_TP_PCT` | no | Solo legacy: take profit en % (opcional, `0` = off) |
| `EXNESS_TP_USD` | no | Solo legacy: take profit fijo en $ (opcional) |
| `TREND_TIMEFRAME_HOURS` | no | `1` (default) o `4` |
| `TREND_RISK_PCT` | no | Riesgo por operación en % del equity (default `0.5`, rango 0.05–2) |
| `TREND_MAX_VOLUME` | no | Tope de volumen en lotes (default `0.5`) |
| `TREND_MAX_SPREAD_PCT` | no | No entrar si spread > % del precio (default `0.05`, `0` = off) |
| `TREND_COOLDOWN_CANDLES` | no | Velas de pausa tras cada pérdida (default `3`) |
| `TREND_DAILY_LOSS_PCT` | no | Pausa del día si el equity cae este % (default `3`) |
| `TREND_TP_R` | no | Objetivo en múltiplos de R (default `2`, `0` = off) |
| `TREND_CANDLE_SOURCE` | no | `auto` (default) · `exness` · `kraken` · `bitstamp` · `coinbase` |
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
2. El **navegador es la fuente de verdad**: guarda el estado del robot (running, config, posición gestionada, log) en `localStorage` y envía el estado completo en cada `POST /api/strategy/tick`. Así un cold start / otra instancia serverless **no** pone `running=false` ni pierde la posición gestionada. Al recargar la pestaña, el robot se reanuda solo.
3. El cliente hace poll a `POST /api/strategy/tick` (~35s) mientras `running`:
   - tick inmediato al Start; al volver a la pestaña hace catch-up si pasaron ≥35s
   - los ticks siguen con la pestaña oculta (el navegador puede ralentizar los timers a ~1/min)
   - un error de tick (mercado cerrado, SL inválido, red, 5xx) **no detiene** el robot: se registra en el log visible y se reintenta (backoff 35s → 60s)
   - si un open no se confirma, el siguiente tick adopta la posición nueva en vez de duplicarla
4. **Deja el dashboard abierto** mientras quieras que el robot opere. Si cierras la pestaña, los ticks paran (y se reanudan al reabrir). La UI muestra estado CORRIENDO/DETENIDO, último/próximo tick, última acción, último error y un log del robot.
5. En **Pro**, puedes reactivar cron minuto en `vercel.json` hacia `GET /api/cron/tick` (auth `CRON_SECRET`) como respaldo.

### Access point y rate limit (429)

El discovery (`/v1/trading/access-point`) tiene rate limit (`AUTH_RATE_LIMIT`). Por eso:

- el access point se cachea en el isolate (TTL 30 min) y el navegador lo guarda en `localStorage` (`exness-ap-v1`) y lo manda en el header `x-exn-ap` (solo se acepta HTTPS bajo el dominio del discovery); un cold start no necesita redescubrir
- ante un 429 se respeta `Retry-After` o backoff exponencial (60s → 600s) y se reutiliza el último access point conocido
- el robot no se marca como roto por un 429: muestra "rate limit, reintentando" y reintenta (≥60s)
- el refresco de la UI es cada 20s y usa un solo snapshot (cuenta + posiciones)

### Estrategia de tendencia (modo `trend`, por defecto)

Se evalúa **solo al cerrar una vela nueva**. El tick corre cada ~35–60 s pero, si no hay vela cerrada sin procesar, solo vigila la posición abierta (precio vivo vs SL/TP/trailing) y no pide velas.

- **Señal (cierre de vela):** compra si EMA20 cruza sobre EMA50 **y** cierre > EMA200; venta en el caso inverso. Una sola posición a la vez. Las señales de más de ⅓ de vela de antigüedad (pestaña cerrada) no se operan.
- **SL** = 1.5 × ATR(14) desde la entrada. **TP** = 2R (parametrizable, 0 = off). **Trailing** opcional: desde `trailActivateR` R de ganancia el SL sigue al mejor precio a `trailAtrMult × ATR`. También se cierra si la tendencia se invierte (cruce EMA contrario, incluso si ocurrió mientras la pestaña estaba cerrada).
- **SL/TP en el broker:** el open se envía con `stop_loss_price`/`take_profit_price`; si el broker lo rechaza se reintenta sin ellos y el robot los vigila. El trailing lo mueve el robot (el SL del broker queda como piso). Si el broker cierra la posición, el siguiente tick lo reconcilia (PnL = Δequity).
- **Tamaño:** riesgo `riskPct`% del equity (default 0.5%): `volumen = riesgo$ / (distancia SL × contract_size)`, redondeado hacia abajo al `volume_step`, respetando `volume_min/max` de `GET …/instruments/{symbol}/conditions` (cacheado 24 h en el estado) y `maxVolume`. Si el riesgo no alcanza para el volumen mínimo, la señal se omite (se loguea).
- **Frenos:** pausa hasta 00:00 UTC si el PnL del día (equity) ≤ −3%; no entra si el spread (bid/ask de la última vela M1 de Exness) supera `maxSpreadPct`; cooldown de N velas tras cada pérdida (default 3).
- **UI** (sección *Robot automático*): parámetros, EMA20/50/200, ATR, última señal, próxima evaluación, riesgo por operación, PnL del día, estado de cada freno y la posición con su SL/TP. El log del robot persiste en `localStorage`; los errores (velas, red, 5xx) se registran y el robot sigue.

#### Fuente de velas

1. **API de Exness** (`GET /v1/market-data/accounts/{id}/candles`, `timeframe=H1|H4`, `price_type=both`): ofrece velas históricas para el instrumento, así que es la fuente preferida (mismos precios que se operan). *No se pudo probar contra cuenta real en desarrollo*: el parser es tolerante con la forma de la respuesta y las velas pasan una validación (orden, alineación, OHLC coherente, ≥ 400 velas); si algo falla se usa el siguiente.
2. **APIs públicas sin clave**, en orden: **Kraken** (720 velas) → **Bitstamp** (1000) → **Coinbase** (solo 1h, 3 páginas). Binance se descartó (HTTP 451 desde regiones restringidas).

Las velas se cachean por isolate (45 s) y se piden solo cuando debería existir una vela cerrada nueva (~1 petición por hora/4 horas).

#### Ejecutar el tick sin navegador (cron / servidor)

`tickStrategy(client, settings, state)` en `lib/strategy.ts` es un paso *estado-entra → estado-sale* sin dependencia del navegador (el runner está en `lib/trend/runner.ts`; `now` y el proveedor de velas son inyectables). Hoy lo llama `POST /api/strategy/tick` con el estado que manda la pestaña; un cron o worker solo necesita **persistir `state`** entre ejecuciones (KV/DB) y llamar `tickStrategy`. `GET /api/cron/tick` (Pro) lo usa con el estado en memoria del isolate, que no es fiable sin KV.

### Backtest

```bash
npx tsx scripts/backtest.ts                       # 3 años, 1h y 4h, spread $20/ida y vuelta
npx tsx scripts/backtest.ts --years 6 --split 0.5 # 6 años, entrenar 50% / validar 50%
npx tsx scripts/backtest.ts --tf 4 --spread 30 --commission 0.005 --refresh
npx tsx scripts/simulate-tick.ts 1 30             # repite el tick EN VIVO contra un broker falso (sin red)
```

Descarga velas de Bitstamp BTC/USD (cacheadas en `scripts/.cache/`) y simula con **las mismas funciones de `lib/trend/engine.ts`** que usa el robot (señal, sizing, SL/TP/trailing, cooldown, pausa diaria, filtro de spread); solo el bucle que alimenta velas es distinto. Reporta ops, win rate, R promedio, profit factor, max drawdown y retorno, por año, con sensibilidad a costos, variantes declaradas a priori, split train/validación y walk-forward rodante (elige parámetros en 12 meses, prueba 3 meses sin reajustar).

**Resultados reales** (BTC/USD Bitstamp hasta 2026-11-07, defaults EMA 20/50/200, SL 1.5×ATR, TP 2R, riesgo 0.5%, spread $20, sin comisión, equity 10 000, filtro de spread off):

| Periodo / TF | Ops | Win rate | R prom. | Profit factor | Max DD | Retorno | Buy & hold |
|---|---|---|---|---|---|---|---|
| 3 años · 1h | 273 | 31.9% | −0.06 | 0.90 | 18.2% | −8.3% | +100% |
| 3 años · 4h | 61 | 39.3% | +0.15 | 1.24 | 3.6% | +4.4% | +76% |
| 6 años · 1h | 559 | 32.4% | −0.06 | 0.91 | 30.0% | −15.6% | +293% |
| 6 años · 4h | 129 | 42.6% | +0.27 | 1.44 | 3.7% | +17.8% | +92% |

Fuera de muestra (6 años, defaults fijos, nada reajustado): split 50/50 en 4h → train PF 1.71 (65 ops) / **validación PF 1.23** (64 ops, +4.4%); en 1h → train 0.91 / validación 0.90. Walk-forward rodante 12m→3m: 1h con parámetros elegidos PF 1.00 (421 ops, −2.4%) y con defaults 0.88 (−18.2%); 4h con parámetros elegidos PF 1.55 (116 ops, +21.8%, DD 8.2%) y con defaults 1.32 (102 ops, +9.7%, DD 3.7%).

**Lectura honesta:** la estrategia tal como se especificó (**1h**) **no es rentable**: expectativa ligeramente negativa en 3 y 6 años y en casi todos los años por separado; con spread 0 queda en PF 0.98 (sin ventaja), y con spread $50 o comisión empeora. Optimizar EMA/ATR/TP dentro de la muestra no se sostiene fuera de ella en 1h. En **4h** hay una ventaja pequeña y estable en signo (PF > 1 todos los años salvo 2025 ≈ 1.0, y en la validación fuera de muestra), pero son pocas operaciones (~20/año), R promedio bajo (+0.14 en la mitad de validación, no concluyente estadísticamente) y rinde mucho menos que buy & hold con riesgo 0.5%. Propuesta: usar **4h** (selector *Timeframe* en la UI o `TREND_TIMEFRAME_HOURS=4`); los parámetros elegidos por walk-forward en 4h (SL 1.5–2×ATR, sin TP, salida por cruce) superaron a los defaults fuera de muestra pero con mucho más drawdown, así que no se cambiaron los defaults. Es un backtest con costos simplificados (spread fijo, sin swaps, fills a la apertura de la vela siguiente): validar en demo antes de confiar en él.

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
| GET/POST | `/api/strategy` | leer / start-stop + config (`trend` params, legacy SL/TP/volume/instrument) |
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
  "tpUsd": 0,
  "trend": { "timeframeHours": 4, "riskPct": 0.5, "tpR": 2, "trailing": false }
}
```

(`entryMode` acepta `trend`; `trend` es parcial y se valida/limita en el servidor. Los campos SL/TP/volumen/`holdTicks` solo aplican a los modos legacy.)

Campos omitidos conservan el estado actual / defaults de env.

## Deploy en Vercel — cómo arranca Rodrigo el robot

1. Repo `rodrigog84/exness-dashboard` importado en Vercel (Root Directory `.`).
2. Environment Variables (Production):
   - `EXN_API_KEY`, `EXN_PRIVATE_KEY`, `EXN_ACCOUNT_ID`, `EXN_DISCOVERY_BASE_URL`
   - `EXNESS_ENV=demo` (no pongas `live` sin `EXNESS_ALLOW_LIVE=yes`)
   - `DASHBOARD_SECRET=<tu clave>`
   - Opcional: `TREND_TIMEFRAME_HOURS=4`, `TREND_RISK_PCT=0.5` (ver tabla de variables)
3. Deploy → abre la URL del proyecto.
4. Login con `DASHBOARD_SECRET`.
5. En **Robot automático** (modo `trend`): revisa timeframe / riesgo % / frenos → pulsa **Start robot**.
6. **Deja la pestaña abierta** — el poll de la UI (~35s) es el motor en Hobby. Verás estado `flat` / `en posición`, indicadores, señal y closes con razón `sl|tp|trail|cross|broker` en Movimientos. Con 1h/4h el robot opera pocas veces: es normal que pasen horas sin acción.
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
components/          Dashboard UI (ES) — Start/Stop robot + panel de estrategia
lib/exness/          Cliente + firma (port del bot Python)
lib/strategy.ts      Estado del robot, tickStrategy (sin navegador) + modos legacy
lib/trend/engine.ts  Lógica pura de tendencia (EMA/ATR, señal, sizing, SL/TP/trailing, frenos) — compartida con el backtest
lib/trend/runner.ts  Tick en vivo de tendencia (broker + estado)
lib/trend/candles.ts Fuentes de velas (Exness → Kraken → Bitstamp → Coinbase) + caché
lib/trend/params.ts  Parámetros, estado y sanitizado (sin dependencias de Node)
lib/auth.ts          Cookie / secret gate
vercel.json          (vacío en Hobby; Pro puede reactivar cron)
scripts/backtest.ts  Backtest + walk-forward (npx tsx)
scripts/simulate-tick.ts  Replay del tick en vivo contra un broker falso
scripts/verify-signing.ts
```
