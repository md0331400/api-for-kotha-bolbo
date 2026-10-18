/**
 * Signed OAuth state for the Google Drive connect flow.
 *
 * state = base64url(payload).signature — HMAC-SHA256 over the payload with
 * API_SECRET_KEY. Payload binds the initiating admin UID and an expiry. A
 * one-time cookie (double-submit) additionally ties the callback to the same
 * browser session.
 */
import { hmacSign, hmacVerify } from "@/lib/ids";

export const OAUTH_STATE_COOKIE = "kb_oauth_state";
const STATE_TTL_MS = 10 * 60 * 1000;

export type OAuthStatePayload = {
  uid: string;
  exp: number;
  nonce: string;
};

export function createOAuthState(secret: string, uid: string, nonce: string): string {
  const payload: OAuthStatePayload = { uid, exp: Date.now() + STATE_TTL_MS, nonce };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${hmacSign(secret, encoded)}`;
}

export function verifyOAuthState(secret: string, state: string): OAuthStatePayload {
  const parts = state.split(".");
  if (parts.length !== 2) throw new Error("malformed state");
  const [encoded, sig] = parts;
  if (!hmacVerify(secret, encoded, sig)) throw new Error("state signature mismatch");
  const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as OAuthStatePayload;
  if (!payload.uid || !payload.exp || payload.exp < Date.now()) throw new Error("state expired");
  return payload;
}
