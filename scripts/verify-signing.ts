/**
 * Offline EXN-* signing test vector (no network, no credentials).
 * Same vector as docs/exness-demo-bot/scripts/verify_signing.py
 */

import {
  buildSignedHeaders,
  loadSigningKey,
} from "../lib/exness/signing";

const HEX_KEY =
  "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60" +
  "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
const API_KEY = "exnsk-synthetic-example";
const TIMESTAMP = 1773656070123;
const PATH = "/v1/trading/access-point?account_id=123456";
const EXPECTED_DATA =
  "eyJhcGlfa2V5IjoiZXhuc2stc3ludGhldGljLWV4YW1wbGUiLCJpZGVtcG90ZW5jeV9rZXkiOiIi" +
  "LCJ0aW1lc3RhbXAiOjE3NzM2NTYwNzAxMjMsInNpZ25fdmVyc2lvbiI6MSwibWV0aG9kIjoiR0VU" +
  "IiwicGF0aCI6Ii92MS90cmFkaW5nL2FjY2Vzcy1wb2ludD9hY2NvdW50X2lkPTEyMzQ1NiIsImJv" +
  "ZHlfaGFzaCI6IjQ3REVRcGo4SEJTYS1fVEltVy01SkNldVFlUmttNU5NcEpXWkczaFN1RlUifQ";
const EXPECTED_SIGN =
  "l-H_Acia8YoTjKFMg-3fon3NOEX8TalNVA7c01DQ9dHb7pVBJC4y06qC-DbpETzh1KToiOprqEV6" +
  "uzN3t69ICQ";

function main(): number {
  const key = loadSigningKey(HEX_KEY);
  const headers = buildSignedHeaders({
    apiKey: API_KEY,
    privateKey: key,
    method: "GET",
    pathWithQuery: PATH,
    body: Buffer.alloc(0),
    timestampMs: TIMESTAMP,
  });

  let ok = true;
  if (headers["EXN-DATA"] !== EXPECTED_DATA) {
    console.error("EXN-DATA mismatch");
    console.error(" got:", headers["EXN-DATA"]);
    console.error("want:", EXPECTED_DATA);
    ok = false;
  }
  if (headers["EXN-SIGN"] !== EXPECTED_SIGN) {
    console.error("EXN-SIGN mismatch");
    console.error(" got:", headers["EXN-SIGN"]);
    console.error("want:", EXPECTED_SIGN);
    ok = false;
  }
  if (headers["EXN-TIMESTAMP"] !== String(TIMESTAMP)) {
    console.error("EXN-TIMESTAMP mismatch");
    ok = false;
  }
  if (headers["EXN-IDEMPOTENCY-KEY"] !== "") {
    console.error("EXN-IDEMPOTENCY-KEY should be empty for GET");
    ok = false;
  }
  if (ok) {
    console.log("Signing test vector OK");
    return 0;
  }
  return 1;
}

process.exit(main());
