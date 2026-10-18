import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { decryptSecret, encryptSecret, isEncryptedEnvelope } from "@/lib/crypto";
import { createOAuthState, verifyOAuthState } from "@/lib/storage/oauth-state";
import { hmacSign, hmacVerify, newFileId } from "@/lib/ids";

describe("secret encryption (AES-256-GCM)", () => {
  const key = randomBytes(32);

  it("round-trips and detects envelopes", () => {
    const enc = encryptSecret(key, "refresh-token-value");
    expect(isEncryptedEnvelope(enc)).toBe(true);
    expect(enc).not.toContain("refresh-token-value");
    expect(decryptSecret(key, enc)).toBe("refresh-token-value");
  });

  it("uses a fresh IV per encryption", () => {
    const a = encryptSecret(key, "same");
    const b = encryptSecret(key, "same");
    expect(a).not.toBe(b);
    expect(decryptSecret(key, a)).toBe(decryptSecret(key, b));
  });

  it("fails on tampering and wrong keys", () => {
    const enc = encryptSecret(key, "secret");
    const parts = enc.split(".");
    const tampered = [parts[0], parts[1], parts[2], Buffer.from("evil").toString("base64url")].join(".");
    expect(() => decryptSecret(key, tampered)).toThrow();
    expect(() => decryptSecret(randomBytes(32), enc)).toThrow();
    expect(isEncryptedEnvelope("plain-refresh-token")).toBe(false);
  });
});

describe("HMAC helpers", () => {
  it("signs and verifies; rejects forgeries", () => {
    const sig = hmacSign("k".repeat(40), "payload");
    expect(hmacVerify("k".repeat(40), "payload", sig)).toBe(true);
    expect(hmacVerify("k".repeat(40), "payload2", sig)).toBe(false);
    expect(hmacVerify("other".repeat(10), "payload", sig)).toBe(false);
  });
});

describe("OAuth state", () => {
  const secret = "s".repeat(40);

  it("round-trips a signed state", () => {
    const state = createOAuthState(secret, "admin-uid-1", "nonce-1");
    const payload = verifyOAuthState(secret, state);
    expect(payload.uid).toBe("admin-uid-1");
    expect(payload.nonce).toBe("nonce-1");
    expect(payload.exp).toBeGreaterThan(Date.now());
  });

  it("rejects tampered or malformed states", () => {
    const state = createOAuthState(secret, "admin-uid-1", "nonce-1");
    const [encoded] = state.split(".");
    const forged = `${Buffer.from(JSON.stringify({ uid: "evil", exp: Date.now() + 10000, nonce: "x" })).toString("base64url")}.${state.split(".")[1]}`;
    expect(() => verifyOAuthState(secret, forged)).toThrow();
    expect(() => verifyOAuthState(secret, `${encoded}.badbadbad`)).toThrow();
    expect(() => verifyOAuthState(secret, "garbage")).toThrow();
  });

  it("rejects expired states", () => {
    // Craft an expired payload with a valid signature to prove expiry is enforced.
    const payload = Buffer.from(
      JSON.stringify({ uid: "u", exp: Date.now() - 1000, nonce: "n" })
    ).toString("base64url");
    const state = `${payload}.${hmacSign(secret, payload)}`;
    expect(() => verifyOAuthState(secret, state)).toThrow();
  });
});

describe("opaque ids", () => {
  it("generates unique prefixed ids", () => {
    const a = newFileId();
    const b = newFileId();
    expect(a).not.toBe(b);
    expect(a.startsWith("file_")).toBe(true);
  });
});
