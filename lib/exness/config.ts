/** Environment configuration with demo-only safety defaults. */

import type { KeyObject } from "node:crypto";
import { ExnessConfigError } from "./errors";
import { loadSigningKey } from "./signing";

export const KNOWN_GATEWAY_HOSTS = ["api.exness.com", "api.exness-api.com"];

function firstEnv(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value != null && value.trim()) return value.trim();
  }
  return undefined;
}

export function normalizeHttpsOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new ExnessConfigError(
      "Expected an HTTPS base URL without credentials, path, query or fragment",
    );
  }
  if (
    url.protocol !== "https:" ||
    !url.hostname ||
    url.username ||
    url.password ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  ) {
    throw new ExnessConfigError(
      "Expected an HTTPS base URL without credentials, path, query or fragment",
    );
  }
  return `https://${url.host}`;
}

export function validateAccountId(accountId: string): string {
  if (!/^[1-9][0-9]*$/.test(accountId) || BigInt(accountId) > 2n ** 64n - 1n) {
    throw new ExnessConfigError(
      "Account ID must be a positive uint64 decimal string",
    );
  }
  return accountId;
}

export type Settings = {
  apiKey: string;
  privateKey: KeyObject;
  accountId: string;
  discoveryBaseUrl: string;
  envMode: "demo" | "live";
  instrument: string;
  side: "buy" | "sell";
  volume: string;
  pollTimeoutSec: number;
  allowLive: boolean;
};

export function loadSettings(): Settings {
  const apiKey = firstEnv("EXN_API_KEY", "EXNESS_API_KEY");
  const privateRaw = firstEnv(
    "EXN_PRIVATE_KEY",
    "EXNESS_API_SECRET",
    "EXNESS_PRIVATE_KEY",
  );
  const accountId = firstEnv("EXN_ACCOUNT_ID", "EXNESS_ACCOUNT_ID");
  const discovery = firstEnv(
    "EXN_DISCOVERY_BASE_URL",
    "EXNESS_BASE_URL",
    "EXNESS_DISCOVERY_BASE_URL",
  );

  const missing = [
    ["EXN_API_KEY / EXNESS_API_KEY", apiKey],
    ["EXN_PRIVATE_KEY / EXNESS_API_SECRET", privateRaw],
    ["EXN_ACCOUNT_ID / EXNESS_ACCOUNT_ID", accountId],
    ["EXN_DISCOVERY_BASE_URL / EXNESS_BASE_URL", discovery],
  ]
    .filter(([, v]) => !v)
    .map(([n]) => n);

  if (missing.length) {
    throw new ExnessConfigError(
      "Missing required environment variables: " + missing.join(", "),
    );
  }

  const envMode = (
    firstEnv("EXNESS_ENV", "EXN_ENV") || "demo"
  ).toLowerCase();
  if (envMode !== "demo" && envMode !== "live") {
    throw new ExnessConfigError("EXNESS_ENV must be 'demo' or 'live'");
  }

  const allowLive = ["1", "true", "yes", "y"].includes(
    (firstEnv("EXNESS_ALLOW_LIVE", "EXN_ALLOW_LIVE") || "").toLowerCase(),
  );

  if (envMode === "live" && !allowLive) {
    throw new ExnessConfigError(
      "Live mode blocked. Set EXNESS_ENV=demo, or EXNESS_ALLOW_LIVE=yes only if intentional.",
    );
  }

  let privateKey: KeyObject;
  try {
    privateKey = loadSigningKey(privateRaw!);
  } catch (err) {
    throw new ExnessConfigError(
      err instanceof Error ? err.message : String(err),
    );
  }

  const instrument = (
    firstEnv("EXNESS_INSTRUMENT", "EXN_INSTRUMENT") || "BTCUSD"
  ).toUpperCase();
  const side = (
    firstEnv("EXNESS_SIDE", "EXN_SIDE") || "buy"
  ).toLowerCase();
  if (side !== "buy" && side !== "sell") {
    throw new ExnessConfigError("EXNESS_SIDE must be 'buy' or 'sell'");
  }
  const volume = firstEnv("EXNESS_VOLUME", "EXN_VOLUME") || "0.01";
  const pollTimeoutSec = Number(
    firstEnv("EXNESS_POLL_TIMEOUT_SEC") || "60",
  );

  return {
    apiKey: apiKey!,
    privateKey,
    accountId: validateAccountId(accountId!),
    discoveryBaseUrl: normalizeHttpsOrigin(discovery!),
    envMode,
    instrument,
    side,
    volume,
    pollTimeoutSec,
    allowLive,
  };
}
