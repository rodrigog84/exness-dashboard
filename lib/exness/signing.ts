/**
 * Ed25519 request signing for Exness EXN-* headers.
 * Port of docs/exness-demo-bot/src/exness_bot/signing.py
 * Spec: https://www.exness-api.com/authentication/request-signing
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomUUID,
  sign as nodeSign,
  type KeyObject,
} from "node:crypto";

export const SIGN_VERSION = 1;
export const EMPTY_BODY_HASH =
  "47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU";

export function b64url(raw: Buffer | Uint8Array): string {
  return Buffer.from(raw)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

/** PKCS#8 DER prefix for a 32-byte Ed25519 seed. */
const ED25519_PKCS8_PREFIX = Buffer.from(
  "302e020100300506032b657004220420",
  "hex",
);

export function loadSigningKey(text: string): KeyObject {
  const trimmed = text.trim();

  if (trimmed.startsWith("-----BEGIN PRIVATE KEY-----")) {
    return createPrivateKey(trimmed);
  }

  if (!/^[0-9a-fA-F]{128}$/.test(trimmed)) {
    throw new Error("Expected 128 hex characters or unencrypted PKCS#8 PEM");
  }

  const raw = Buffer.from(trimmed, "hex"); // 32-byte seed + 32-byte public
  const seed = raw.subarray(0, 32);
  const expectedPub = raw.subarray(32);
  const der = Buffer.concat([ED25519_PKCS8_PREFIX, seed]);
  const key = createPrivateKey({ key: der, format: "der", type: "pkcs8" });

  const pubSpki = createPublicKey(key).export({ type: "spki", format: "der" });
  const rawPub = Buffer.from(pubSpki).subarray(-32);
  if (!rawPub.equals(expectedPub)) {
    throw new Error("Private key public half does not match its seed");
  }
  return key;
}

export function createIdempotencyKey(prefix = "exn"): string {
  return `${prefix}-${randomUUID()}`;
}

export function buildSignedHeaders(opts: {
  apiKey: string;
  privateKey: KeyObject;
  method: string;
  pathWithQuery: string;
  body?: Buffer | Uint8Array;
  idempotencyKey?: string | null;
  timestampMs?: number;
}): Record<string, string> {
  const methodU = opts.method.toUpperCase();
  let idem: string;
  if (methodU === "GET") {
    idem = "";
  } else {
    idem =
      opts.idempotencyKey != null
        ? opts.idempotencyKey
        : createIdempotencyKey();
    if (!idem) {
      throw new Error("Mutating requests require a non-empty idempotency key");
    }
  }

  const timestamp =
    opts.timestampMs != null ? opts.timestampMs : Date.now();
  const body =
    opts.body && opts.body.length > 0 ? Buffer.from(opts.body) : null;
  const bodyHash = body
    ? b64url(createHash("sha256").update(body).digest())
    : EMPTY_BODY_HASH;

  // Compact JSON — same bytes for EXN-DATA and the signature payload.
  const payloadObj = {
    api_key: opts.apiKey,
    idempotency_key: idem,
    timestamp,
    sign_version: SIGN_VERSION,
    method: methodU,
    path: opts.pathWithQuery,
    body_hash: bodyHash,
  };
  const payload = Buffer.from(JSON.stringify(payloadObj), "utf8");
  const signature = nodeSign(null, payload, opts.privateKey);

  return {
    "EXN-API-KEY": opts.apiKey,
    "EXN-IDEMPOTENCY-KEY": idem,
    "EXN-TIMESTAMP": String(timestamp),
    "EXN-SIGN-VERSION": String(SIGN_VERSION),
    "EXN-DATA": b64url(payload),
    "EXN-SIGN": b64url(signature),
  };
}

export function redactHeaders(
  headers: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(headers)) {
    const upper = key.toUpperCase();
    if (
      upper === "EXN-DATA" ||
      upper === "EXN-SIGN" ||
      upper === "EXN-API-KEY" ||
      upper === "AUTHORIZATION"
    ) {
      out[key] = "<redacted>";
    } else {
      out[key] = value;
    }
  }
  return out;
}
