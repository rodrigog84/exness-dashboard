/**
 * HTTP client for Exness Public Trader API (REST).
 * Port of docs/exness-demo-bot/src/exness_bot/client.py
 */

import { loadSettings, normalizeHttpsOrigin, type Settings } from "./config";
import { ExnessApiError, ExnessConfigError } from "./errors";
import { buildSignedHeaders, createIdempotencyKey } from "./signing";

type Json = Record<string, unknown>;

/**
 * Discovery is rate limited (429 AUTH_RATE_LIMIT), so the access point is
 * cached for the whole isolate and shared by every client instance / request.
 */
const AP_TTL_MS = 30 * 60_000;
const RL_BASE_SEC = 60;
const RL_MAX_SEC = 600;

type ApCache = {
  entries: Record<string, { url: string; at: number }>;
  blockedUntil: number;
  strikes: number;
};

const g = globalThis as unknown as { __exnAp?: ApCache };

function apCache(): ApCache {
  if (!g.__exnAp) g.__exnAp = { entries: {}, blockedUntil: 0, strikes: 0 };
  return g.__exnAp;
}

function parseRetryAfter(h: string | null): number | undefined {
  if (!h) return undefined;
  const n = Number(h);
  if (Number.isFinite(n)) return Math.max(0, Math.ceil(n));
  const d = Date.parse(h);
  if (Number.isFinite(d)) return Math.max(0, Math.ceil((d - Date.now()) / 1000));
  return undefined;
}

export class ExnessTraderClient {
  settings: Settings;
  private timeoutMs: number;
  private _accessPoint: string | null;
  private _apAt = 0;

  constructor(opts?: {
    settings?: Settings;
    timeoutMs?: number;
    accessPoint?: string;
  }) {
    this.settings = opts?.settings ?? loadSettings();
    this.timeoutMs = opts?.timeoutMs ?? 30_000;
    this._accessPoint = opts?.accessPoint
      ? normalizeHttpsOrigin(opts.accessPoint)
      : null;
    if (this._accessPoint) this._apAt = Date.now();
  }

  /** Last known access point (possibly stale), or null. */
  knownAccessPoint(): string | null {
    return (
      this._accessPoint ??
      apCache().entries[this.settings.accountId]?.url ??
      null
    );
  }

  /**
   * Accept an access point remembered by the browser. Only HTTPS hosts under
   * the discovery host's parent domain are trusted (signed requests go there).
   * Ignored when we already hold a fresh one.
   */
  seedAccessPoint(raw: string | null | undefined): boolean {
    if (!raw) return false;
    try {
      const url = normalizeHttpsOrigin(raw);
      const host = new URL(url).hostname.toLowerCase();
      const parent = new URL(this.settings.discoveryBaseUrl).hostname
        .toLowerCase()
        .split(".")
        .slice(-2)
        .join(".");
      if (host !== parent && !host.endsWith(`.${parent}`)) return false;
      const cached = apCache().entries[this.settings.accountId];
      if (cached && Date.now() - cached.at < AP_TTL_MS) return false;
      apCache().entries[this.settings.accountId] = { url, at: Date.now() };
      return true;
    } catch {
      return false;
    }
  }

  async discoverAccessPoint(force = false): Promise<string> {
    const key = this.settings.accountId;
    const cache = apCache();
    const now = Date.now();
    const cached = cache.entries[key];

    if (!force) {
      if (this._accessPoint && now - this._apAt < AP_TTL_MS) {
        return this._accessPoint;
      }
      if (cached && now - cached.at < AP_TTL_MS) {
        this._accessPoint = cached.url;
        this._apAt = cached.at;
        return cached.url;
      }
    }

    const known = this._accessPoint ?? cached?.url ?? null;

    if (now < cache.blockedUntil) {
      if (known) return known;
      throw new ExnessApiError(
        "Discovery en rate limit (429), esperando antes de reintentar",
        {
          statusCode: 429,
          retryAfterSec: Math.ceil((cache.blockedUntil - now) / 1000),
        },
      );
    }

    const path = `/v1/trading/access-point?account_id=${this.settings.accountId}`;
    let data: Json;
    try {
      data = await this.requestJson({
        baseUrl: this.settings.discoveryBaseUrl,
        method: "GET",
        pathWithQuery: path,
      });
    } catch (err) {
      if (err instanceof ExnessApiError && err.statusCode === 429) {
        cache.strikes += 1;
        const backoff = Math.min(
          RL_MAX_SEC,
          RL_BASE_SEC * 2 ** (cache.strikes - 1),
        );
        const wait = Math.max(err.retryAfterSec ?? 0, backoff);
        cache.blockedUntil = Date.now() + wait * 1000;
        err.retryAfterSec = wait;
        if (known) return known;
      }
      throw err;
    }
    const value = data.access_point;
    if (typeof value !== "string" || !value) {
      throw new ExnessApiError("Discovery response missing access_point", {
        body: safeBody(data),
      });
    }
    const url = normalizeHttpsOrigin(value);
    cache.strikes = 0;
    cache.blockedUntil = 0;
    cache.entries[key] = { url, at: Date.now() };
    this._accessPoint = url;
    this._apAt = Date.now();
    return url;
  }

  async accessPoint(): Promise<string> {
    return this.discoverAccessPoint();
  }

  async getAccount(): Promise<Json> {
    const id = this.settings.accountId;
    return this.apJson("GET", `/v1/configuration/accounts/${id}/account`);
  }

  async getSnapshot(): Promise<Json> {
    const id = this.settings.accountId;
    return this.apJson("GET", `/v1/trading/accounts/${id}/snapshot`);
  }

  async getInstrumentConditions(instrument?: string): Promise<Json> {
    const id = this.settings.accountId;
    const symbol = (instrument || this.settings.instrument).toUpperCase();
    return this.apJson(
      "GET",
      `/v1/configuration/accounts/${id}/instruments/${symbol}/conditions`,
    );
  }

  async getOperation(operationId: string): Promise<Json> {
    const id = this.settings.accountId;
    return this.apJson(
      "GET",
      `/v1/trading/accounts/${id}/operations/${operationId}`,
    );
  }

  async waitForOperation(
    operationId: string,
    opts?: { timeoutSec?: number; intervalMs?: number },
  ): Promise<Json> {
    const deadline =
      Date.now() +
      (opts?.timeoutSec ?? this.settings.pollTimeoutSec) * 1000;
    const interval = opts?.intervalMs ?? 1000;
    let last: Json = {};
    while (Date.now() < deadline) {
      last = await this.getOperation(operationId);
      const status = String(
        last.status ?? last.operation_status ?? "",
      ).toLowerCase();
      if (["confirmed", "rejected", "failed"].includes(status)) return last;
      await sleep(interval);
    }
    throw new ExnessApiError(
      `Timed out waiting for operation ${operationId}`,
      { body: safeBody(last) },
    );
  }

  async openPosition(opts?: {
    instrument?: string;
    side?: string;
    volume?: string;
    price?: string;
    stopLossPrice?: string;
    takeProfitPrice?: string;
    deviation?: number;
    idempotencyKey?: string;
  }): Promise<Json> {
    const id = this.settings.accountId;
    const body: Json = {
      instrument: (opts?.instrument || this.settings.instrument).toUpperCase(),
      side: (opts?.side || this.settings.side).toLowerCase(),
      volume: String(opts?.volume || this.settings.volume),
    };
    if (opts?.price != null) body.price = String(opts.price);
    if (opts?.stopLossPrice != null)
      body.stop_loss_price = String(opts.stopLossPrice);
    if (opts?.takeProfitPrice != null)
      body.take_profit_price = String(opts.takeProfitPrice);
    if (opts?.deviation != null) body.deviation = opts.deviation;

    return this.apJson("POST", `/v1/trading/accounts/${id}/positions`, {
      jsonBody: body,
      idempotencyKey:
        opts?.idempotencyKey || createIdempotencyKey("open-position"),
      expectedStatuses: [200, 202],
    });
  }

  async closePosition(
    positionId: string,
    opts?: {
      volume?: string;
      price?: string;
      deviation?: number;
      closeByPositionId?: string;
      idempotencyKey?: string;
    },
  ): Promise<Json> {
    const id = this.settings.accountId;
    const query = new URLSearchParams();
    if (opts?.volume != null) query.set("volume", String(opts.volume));
    if (opts?.price != null) query.set("price", String(opts.price));
    if (opts?.deviation != null)
      query.set("deviation", String(opts.deviation));
    if (opts?.closeByPositionId != null)
      query.set("close_by_position_id", String(opts.closeByPositionId));

    let path = `/v1/trading/accounts/${id}/positions/${positionId}`;
    const qs = query.toString();
    if (qs) path = `${path}?${qs}`;

    return this.apJson("DELETE", path, {
      idempotencyKey:
        opts?.idempotencyKey || createIdempotencyKey("close-position"),
      expectedStatuses: [200, 202],
    });
  }

  extractAccountState(snapshot?: Json): Json {
    const snap = snapshot;
    if (!snap) return {};
    const state = snap.account_state;
    if (state && typeof state === "object") return state as Json;
    const payload = snap.payload;
    if (
      payload &&
      typeof payload === "object" &&
      (payload as Json).account_state &&
      typeof (payload as Json).account_state === "object"
    ) {
      return (payload as Json).account_state as Json;
    }
    return {};
  }

  extractPositions(snapshot?: Json): Json[] {
    const snap = snapshot;
    if (!snap) return [];
    for (const key of ["positions", "open_positions"] as const) {
      const value = snap[key];
      if (Array.isArray(value)) {
        return value.filter((p) => p && typeof p === "object") as Json[];
      }
    }
    const payload = snap.payload;
    if (payload && typeof payload === "object") {
      for (const key of ["positions", "open_positions"] as const) {
        const value = (payload as Json)[key];
        if (Array.isArray(value)) {
          return value.filter((p) => p && typeof p === "object") as Json[];
        }
      }
    }
    return [];
  }

  private async apJson(
    method: string,
    pathWithQuery: string,
    opts?: {
      jsonBody?: Json;
      idempotencyKey?: string;
      expectedStatuses?: number[];
    },
  ): Promise<Json> {
    return this.requestJson({
      baseUrl: await this.accessPoint(),
      method,
      pathWithQuery,
      jsonBody: opts?.jsonBody,
      idempotencyKey: opts?.idempotencyKey,
      expectedStatuses: opts?.expectedStatuses,
    });
  }

  private async requestJson(opts: {
    baseUrl: string;
    method: string;
    pathWithQuery: string;
    jsonBody?: Json;
    idempotencyKey?: string;
    expectedStatuses?: number[];
  }): Promise<Json> {
    if (!opts.pathWithQuery.startsWith("/")) {
      throw new ExnessConfigError("pathWithQuery must start with '/'");
    }

    const expected = opts.expectedStatuses ?? [200];
    let bodyBytes: Buffer | null = null;
    const headersExtra: Record<string, string> = {};
    if (opts.jsonBody != null) {
      bodyBytes = Buffer.from(JSON.stringify(opts.jsonBody), "utf8");
      headersExtra["Content-Type"] = "application/json";
    }

    const signed = buildSignedHeaders({
      apiKey: this.settings.apiKey,
      privateKey: this.settings.privateKey,
      method: opts.method,
      pathWithQuery: opts.pathWithQuery,
      body: bodyBytes ?? undefined,
      idempotencyKey: opts.idempotencyKey,
    });
    const headers = { ...signed, ...headersExtra };
    const url = `${opts.baseUrl}${opts.pathWithQuery}`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: opts.method.toUpperCase(),
        headers,
        body: bodyBytes ? new Uint8Array(bodyBytes) : undefined,
        redirect: "manual", // never forward signed headers on redirect
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new ExnessApiError(
        `Transport error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const text = await response.text();
    const parsed = tryJson(text);

    if (!expected.includes(response.status)) {
      const [errCode, errMsg] = extractError(parsed);
      throw new ExnessApiError(
        `HTTP ${response.status} for ${opts.method.toUpperCase()} ${opts.pathWithQuery}` +
          (errCode || errMsg ? ` [${errCode ?? ""}] ${errMsg ?? ""}` : ""),
        {
          statusCode: response.status,
          errorCode: errCode,
          errorMessage: errMsg,
          body: safeBody(parsed),
          retryAfterSec: parseRetryAfter(response.headers.get("retry-after")),
        },
      );
    }

    if (!text) return {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ExnessApiError("Expected JSON object response", {
        statusCode: response.status,
        body: safeBody(parsed),
      });
    }
    return parsed as Json;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function tryJson(text: string): unknown {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 500) };
  }
}

function extractError(
  body: unknown,
): [string | number | null, string | null] {
  if (!body || typeof body !== "object") return [null, null];
  const b = body as Json;
  const error = b.error;
  if (error && typeof error === "object") {
    const e = error as Json;
    const code = (e.code ?? e.error_code) as string | number | undefined;
    const msg =
      (e.error_message as string) ||
      (e.message as string) ||
      (e.description as string);
    return [code ?? null, msg ?? null];
  }
  const code = (b.error_code ?? b.code) as string | number | undefined;
  const msg =
    (b.error_message as string) ||
    (b.description as string) ||
    (b.message as string);
  return [code ?? null, msg ?? null];
}

function safeBody(body: unknown): unknown {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const out: Json = {};
    for (const [k, v] of Object.entries(body as Json)) {
      const lower = k.toLowerCase();
      if (lower.includes("key") || lower.includes("secret")) continue;
      out[k] = v;
    }
    return out;
  }
  return body;
}

export function positionId(pos: Json): string | null {
  for (const key of ["position_id", "id"]) {
    const value = pos[key];
    if (value != null) return String(value);
  }
  return null;
}
