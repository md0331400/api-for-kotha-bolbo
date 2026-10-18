import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM encryption for sensitive values at rest (Google OAuth refresh
 * tokens). Key comes from CREDENTIALS_ENCRYPTION_KEY (64 hex chars) and is
 * server-only. Format: v1.<iv-b64url>.<tag-b64url>.<ciphertext-b64url>
 */

const VERSION = "v1";

export function encryptSecret(key: Buffer, plaintext: string): string {
  if (key.length !== 32) throw new Error("encryption key must be 32 bytes");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), tag.toString("base64url"), ct.toString("base64url")].join(".");
}

export function decryptSecret(key: Buffer, encoded: string): string {
  if (key.length !== 32) throw new Error("encryption key must be 32 bytes");
  const parts = encoded.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) throw new Error("unsupported ciphertext format");
  const iv = Buffer.from(parts[1], "base64url");
  const tag = Buffer.from(parts[2], "base64url");
  const ct = Buffer.from(parts[3], "base64url");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

/** True when the stored value is our envelope (and therefore must be decrypted). */
export function isEncryptedEnvelope(value: string): boolean {
  return value.startsWith(`${VERSION}.`) && value.split(".").length === 4;
}
