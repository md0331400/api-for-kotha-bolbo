/**
 * Client API keys — a credential system separate from Firebase ID tokens and
 * from the server-side API_SECRET_KEY (which is an HMAC secret and is never
 * issued to anyone).
 *
 * Key format (shown ONCE at creation):
 *
 *   kb_<keyId>_<secret>
 *     keyId  — 16 hex chars (8 random bytes), public identifier (`ak_<keyId>`)
 *     secret — 32 random bytes, base64url (43 chars)
 *   The key id is hex so the format is unambiguous (base64url may contain "_").
 *
 * Only `sha256(rawKey)` is persisted. Verification looks the record up by the
 * public keyId and compares hashes with `timingSafeEqual`.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Store } from "@/lib/db/store";
import { API_KEY_SCOPES, type ApiKeyRecord, type ApiKeyScope } from "@/lib/db/types";
import { ApiError } from "@/lib/errors";

export const API_KEY_HEADER = "x-api-key";
export const API_KEY_PREFIX = "kb";

const KEY_ID_BYTES = 8; // -> 16 hex chars
const SECRET_BYTES = 32; // -> 43 base64url chars
const RAW_KEY_RE = /^kb_([0-9a-f]{16})_([A-Za-z0-9_-]{43})$/;

/** Throttle `lastUsedAt` writes to at most once per minute per key. */
const LAST_USED_WRITE_INTERVAL_MS = 60_000;

export function hashApiKey(rawKey: string): string {
  return createHash("sha256").update(rawKey, "utf8").digest("hex");
}

export function isValidScope(s: string): s is ApiKeyScope {
  return (API_KEY_SCOPES as readonly string[]).includes(s);
}

/** Generate a new raw key and its public identifier. */
export function generateApiKey(): { rawKey: string; keyId: string; prefix: string; secretHash: string } {
  const keyIdPart = randomBytes(KEY_ID_BYTES).toString("hex");
  const secret = randomBytes(SECRET_BYTES).toString("base64url");
  const rawKey = `${API_KEY_PREFIX}_${keyIdPart}_${secret}`;
  if (!RAW_KEY_RE.test(rawKey)) {
    // Defensive: base64url of fixed byte lengths always matches, but never
    // emit a key the verifier would reject.
    throw new Error("generated key failed self-check");
  }
  return {
    rawKey,
    keyId: `ak_${keyIdPart}`,
    prefix: `${API_KEY_PREFIX}_${keyIdPart}_${secret.slice(0, 4)}…`,
    secretHash: hashApiKey(rawKey),
  };
}

/** Masked identifier safe to display in lists. */
export function maskApiKey(rec: Pick<ApiKeyRecord, "prefix">): string {
  return rec.prefix;
}

export type VerifiedApiKey = {
  record: ApiKeyRecord;
};

/**
 * Verify a raw key presented by a client. Fails closed on any irregularity
 * (format, unknown id, hash mismatch, revoked, expired).
 */
export async function verifyApiKey(store: Store, rawKey: string, now = Date.now()): Promise<VerifiedApiKey> {
  const trimmed = rawKey.trim();
  const m = RAW_KEY_RE.exec(trimmed);
  if (!m) throw new ApiError("TOKEN_INVALID", "API key is malformed.");
  const keyId = `ak_${m[1]}`;
  const record = await store.getApiKey(keyId);
  if (!record) throw new ApiError("TOKEN_INVALID", "API key is not recognised.");

  const presented = Buffer.from(hashApiKey(trimmed), "hex");
  const stored = Buffer.from(record.secretHash ?? "", "hex");
  if (presented.length !== stored.length || !timingSafeEqual(presented, stored)) {
    throw new ApiError("TOKEN_INVALID", "API key is not recognised.");
  }
  if (record.status !== "active") throw new ApiError("TOKEN_INVALID", "API key has been revoked.");
  if (record.expiresAt && record.expiresAt <= now) throw new ApiError("TOKEN_EXPIRED", "API key has expired.");

  if (!record.lastUsedAt || now - record.lastUsedAt > LAST_USED_WRITE_INTERVAL_MS) {
    // Best-effort; never fail the request because telemetry could not be written.
    await store.updateApiKey(record.id, { lastUsedAt: now }).catch(() => undefined);
    record.lastUsedAt = now;
  }
  return { record };
}

export function hasScope(scopes: readonly ApiKeyScope[] | undefined, required: ApiKeyScope): boolean {
  return Boolean(scopes && scopes.includes(required));
}

function _safeISOString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
    return null;
  }
  if (typeof value === "string") {
    const t = Date.parse(value);
    if (Number.isFinite(t)) return new Date(t).toISOString();
    return null;
  }
  return null;
}
function _safeISOStringRequired(value: unknown): string | null {
  const s = _safeISOString(value);
  // Do not fabricate "now" for missing historical timestamps — return null so UI shows "—"
  return s ?? null;
}

/** Public, non-secret projection for the admin dashboard. */
export function publicApiKey(rec: ApiKeyRecord) {
  if (!rec || typeof rec.id !== "string") {
    return {
      id: String((rec as unknown as Record<string, unknown>)?.id ?? "unknown"),
      name: String((rec as unknown as Record<string, unknown>)?.name ?? ""),
      maskedKey: "",
      subjectUid: String((rec as unknown as Record<string, unknown>)?.subjectUid ?? ""),
      appId: null,
      scopes: [],
      status: "active" as const,
      createdAt: null as string | null,
      createdBy: "",
      createdByEmail: null,
      lastUsedAt: null,
      revokedAt: null,
      revokedBy: null,
      expiresAt: null,
    };
  }
  return {
    id: rec.id,
    name: typeof rec.name === "string" ? rec.name : "",
    maskedKey: rec.prefix ? maskApiKey(rec as Pick<ApiKeyRecord, "prefix">) : "",
    subjectUid: typeof rec.subjectUid === "string" ? rec.subjectUid : "",
    appId: rec.appId || null,
    scopes: Array.isArray(rec.scopes) ? rec.scopes : [],
    status: rec.status,
    createdAt: _safeISOStringRequired((rec as unknown as Record<string, unknown>).createdAt),
    createdBy: typeof rec.createdBy === "string" ? rec.createdBy : "",
    createdByEmail: typeof rec.createdByEmail === "string" ? rec.createdByEmail : null,
    lastUsedAt: _safeISOString((rec as unknown as Record<string, unknown>).lastUsedAt),
    revokedAt: _safeISOString((rec as unknown as Record<string, unknown>).revokedAt),
    revokedBy: typeof rec.revokedBy === "string" ? rec.revokedBy : null,
    expiresAt: _safeISOString((rec as unknown as Record<string, unknown>).expiresAt),
  };
}
