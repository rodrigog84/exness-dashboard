# Exness Trading Dashboard (Next.js · Vercel)

Panel web **demo** para la cuenta de trading Exness de Rodrigo: balance/equity, posiciones, movimientos y una estrategia placeholder (open → hold → close).

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
| `EXNESS_ENV` | no | `demo` (default). `live` requiere `EXNESS_ALLOW_LIVE=yes` |
| `DASHBOARD_SECRET` | recomendada | Clave compartida del panel (cookie + header `x-dashboard-secret`) |
| `EXNESS_INSTRUMENT` | no | Default `BTCUSD` |
| `EXNESS_VOLUME` | no | Default `0.01` |
| `CRON_SECRET` | Vercel | Auto en Vercel Pro/Hobby para `/api/cron/tick` |

**Nunca** uses prefijos `NEXT_PUBLIC_` para secrets. No loguear `EXN-DATA` / `EXN-SIGN` / private key.

## Local

```bash
cd docs/exness-dashboard
npm install
cp .env.example .env.local   # rellena DEMO keys + DASHBOARD_SECRET
npm run verify:signing       # vector oficial offline
npm run dev                  # http://localhost:3000
```

## Cómo funciona la estrategia (serverless)

En Vercel **no** hay un proceso forever. El bucle es:

1. UI pone `running=true` vía `POST /api/strategy`.
2. El cliente hace poll a `POST /api/strategy/tick` cada ~35s mientras está running.
3. Opcional: **Vercel Cron** (`vercel.json`) llama `GET /api/cron/tick` cada minuto (auth `CRON_SECRET`).
4. Cada tick: si no hay posición gestionada → open mercado mínimo; si ya hay y `ticksSinceOpen ≥ holdTicks` (default 3) → close.

Estado de estrategia y log de movimientos: **in-memory** por isolate. Un cold start reinicia `running=false` y vacía el log. Para producción seria: KV / DB.

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
| GET/POST | `/api/strategy` | leer / start-stop + config |
| POST | `/api/strategy/tick` | un paso de estrategia |
| GET | `/api/cron/tick` | cron Vercel |

## Deploy en Vercel

### Opción A — Import desde GitHub

1. Crea un repo privado (p. ej. `exness-trading-dashboard`) y sube **solo** el contenido de esta carpeta como root (o apunta Root Directory a `docs/exness-dashboard` si vive en un monorepo).
2. Vercel → **Add New Project** → Import repo.
3. Framework: Next.js. Root Directory: `.` (o la subcarpeta).
4. Environment Variables: todas las de la tabla (`EXNESS_ENV=demo`, `DASHBOARD_SECRET=…`).
5. Deploy. Abre la URL, entra con la clave, prueba open/close en BTCUSD demo.

### Opción B — Sin Git (CLI / carpeta)

```bash
npm i -g vercel
cd docs/exness-dashboard
vercel          # link proyecto
vercel env add EXN_API_KEY   # … repetir para cada secret
vercel --prod
```

O arrastra la carpeta en [vercel.com/new](https://vercel.com/new) si tu plan lo permite.

### Cron

`vercel.json` ya declara cron cada minuto a `/api/cron/tick`. En Hobby el mínimo puede ser 1×/día según plan; el poll de la UI cubre el bucle mientras el panel está abierto.

## Seguridad

- Solo demo por defecto; live bloqueado sin `EXNESS_ALLOW_LIVE=yes`.
- Firma Ed25519 en Node (`crypto`); redirects desactivados.
- Access Point cacheado en el isolate (discovery rate-limited).
- Forex puede devolver `trading_disabled` en fin de semana; BTCUSD suele operar.

## Estructura

```
app/                 App Router pages + Route Handlers
components/          Dashboard UI (ES)
lib/exness/          Cliente + firma (port del bot Python)
lib/strategy.ts      Estado + tick placeholder
lib/auth.ts          Cookie / secret gate
vercel.json          Cron
scripts/verify-signing.ts
```
