/**
 * Structured server-side logging. Secrets (tokens, keys, passwords, file
 * contents) are never logged; callers must not pass them.
 */

type Level = "debug" | "info" | "warn" | "error";

const REDACT_KEYS = [
  "password",
  "idToken",
  "token",
  "accessToken",
  "refreshToken",
  "refresh_token",
  "access_token",
  "privateKey",
  "private_key",
  "authorization",
  "clientSecret",
  "client_secret",
  "apiKey",
  "api_key",
];

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[depth]";
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (REDACT_KEYS.some((r) => k.toLowerCase().includes(r.toLowerCase()))) {
      out[k] = "[redacted]";
    } else {
      out[k] = redact(v, depth + 1);
    }
  }
  return out;
}

function emit(level: Level, msg: string, meta?: Record<string, unknown>) {
  const entry = {
    level,
    msg,
    time: new Date().toISOString(),
    ...(meta ? (redact(meta) as Record<string, unknown>) : {}),
  };
  const line = JSON.stringify(entry);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (msg: string, meta?: Record<string, unknown>) => emit("debug", msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => emit("info", msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => emit("warn", msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => emit("error", msg, meta),
};
