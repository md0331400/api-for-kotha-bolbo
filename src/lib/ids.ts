import { randomBytes, randomUUID, createHmac, timingSafeEqual } from "node:crypto";

/** Opaque, URL-safe identifier with a type prefix. */
export function newId(prefix: string, bytes = 12): string {
  return `${prefix}_${randomBytes(bytes).toString("base64url")}`;
}

export const newFileId = () => newId("file", 12);
export const newUploadId = () => newId("up", 12);
export const newAccountId = () => newId("drv", 8);
export const newLogId = () => newId("log", 10);
export const newRunId = () => newId("run", 8);
export const newRequestId = () => randomUUID();
export const newOAuthState = () => newId("st", 18);

export function hmacSign(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function hmacVerify(secret: string, payload: string, signature: string): boolean {
  const expected = hmacSign(secret, payload);
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Random secret for download links etc. */
export function randomSecret(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}
