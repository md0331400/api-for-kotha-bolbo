/**
 * Central, typed access to environment configuration.
 *
 * Rules:
 *  - Private credentials are read only here and only on the server.
 *  - Configuration errors mention missing VARIABLE NAMES only; values are
 *    never printed, logged, or returned to clients.
 */

export class ConfigError extends Error {
  readonly missing: string[];
  constructor(missing: string[]) {
    super(
      `Missing required environment configuration: ${missing.join(", ")}. ` +
        `Set these in Vercel Project Settings → Environment Variables (server-only).`
    );
    this.name = "ConfigError";
    this.missing = missing;
  }
}

export type FirebaseWebConfig = {
  apiKey: string;
  authDomain: string;
  databaseURL: string;
  projectId: string;
  storageBucket: string;
  messagingSenderId: string;
  appId: string;
};

function raw(name: string): string | undefined {
  const v = process.env[name];
  if (v === undefined) return undefined;
  const trimmed = v.trim();
  return trimmed === "" ? undefined : trimmed;
}

function intFromEnv(name: string, fallback: number): number {
  const v = raw(name);
  if (!v) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    throw new ConfigError([`${name} (must be a non-negative integer)`]);
  }
  return n;
}

function intListFromEnv(name: string, fallback: number[]): number[] {
  const v = raw(name);
  if (!v) return fallback;
  const parts = v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const out: number[] = [];
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isInteger(n) || n <= 0 || n > 365) {
      throw new ConfigError([`${name} (comma-separated positive integers)`]);
    }
    out.push(n);
  }
  return out.length ? out : fallback;
}

/** Whether the server-side Firebase Admin credentials are present. */
export function hasAdminCredentials(): boolean {
  return Boolean(raw("FIREBASE_CLIENT_EMAIL") && raw("FIREBASE_PRIVATE_KEY") && raw("FIREBASE_PROJECT_ID"));
}

/** Whether the Realtime Database URL is present. */
export function hasDatabaseConfig(): boolean {
  return Boolean(raw("FIREBASE_DATABASE_URL"));
}

/** Whether Google OAuth (Drive pool) credentials are present. */
export function hasGoogleOAuthConfig(): boolean {
  return Boolean(raw("GOOGLE_OAUTH_CLIENT_ID") && raw("GOOGLE_OAUTH_CLIENT_SECRET"));
}

/** Names of server-side config groups that are missing (safe to expose). */
export function missingConfigGroups(): string[] {
  const missing: string[] = [];
  if (!raw("FIREBASE_PROJECT_ID")) missing.push("FIREBASE_PROJECT_ID");
  if (!hasAdminCredentials()) missing.push("FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY");
  if (!hasDatabaseConfig()) missing.push("FIREBASE_DATABASE_URL");
  return missing;
}

export type AppConfig = {
  appBaseUrl: string;
  corsOrigins: string[];
  firebaseWeb: FirebaseWebConfig;
  adminClientEmail: string;
  adminPrivateKey: string;
  projectId: string;
  databaseUrl: string;
  apiSecretKey: string;
  credentialsEncryptionKey?: Buffer;
  cronSecret?: string;
  googleOAuthClientId: string;
  googleOAuthClientSecret: string;
  googleOAuthScopes: string[];
  defaultUserQuotaBytes: number;
  maxUploadBytes: number;
  fileTtlDays: number;
  notifyExpiryDays: number[];
  uploadTicketTtlMinutes: number;
  adminEmails: string[];
  appVersionDefault: string;
};

/**
 * Full configuration used by request handlers. Throws ConfigError listing the
 * names of missing variables. Never includes secrets in the error message.
 */
export function loadConfig(): AppConfig {
  const missing: string[] = [];

  const projectId = raw("FIREBASE_PROJECT_ID") ?? "";
  const clientEmail = raw("FIREBASE_CLIENT_EMAIL") ?? "";
  const privateKeyRaw = raw("FIREBASE_PRIVATE_KEY") ?? "";
  const databaseUrl = raw("FIREBASE_DATABASE_URL") ?? "";

  if (!projectId) missing.push("FIREBASE_PROJECT_ID");
  if (!clientEmail) missing.push("FIREBASE_CLIENT_EMAIL");
  if (!privateKeyRaw) missing.push("FIREBASE_PRIVATE_KEY");
  if (!databaseUrl) missing.push("FIREBASE_DATABASE_URL");
  const apiSecretKey = raw("API_SECRET_KEY") ?? "";
  if (!apiSecretKey || apiSecretKey.length < 32) missing.push("API_SECRET_KEY (min 32 chars)");

  if (missing.length) throw new ConfigError(missing);

  // Handle PEM newline escaping coming from env stores.
  const adminPrivateKey = privateKeyRaw.replace(/\\n/g, "\n");

  const encKeyRaw = raw("CREDENTIALS_ENCRYPTION_KEY");
  let credentialsEncryptionKey: Buffer | undefined;
  if (encKeyRaw) {
    if (!/^[0-9a-fA-F]{64}$/.test(encKeyRaw)) {
      throw new ConfigError(["CREDENTIALS_ENCRYPTION_KEY (64 hex chars)"]);
    }
    credentialsEncryptionKey = Buffer.from(encKeyRaw, "hex");
  }

  const appBaseUrl = raw("APP_BASE_URL") ?? "https://swkf.vercel.app";
  const corsOrigins = (raw("CORS_ORIGINS") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const googleOAuthClientId = raw("GOOGLE_OAUTH_CLIENT_ID") ?? "";
  const googleOAuthClientSecret = raw("GOOGLE_OAUTH_CLIENT_SECRET") ?? "";
  const googleOAuthScopes = (
    raw("GOOGLE_OAUTH_SCOPES") ??
    "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile"
  )
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const defaultUserQuotaBytes = intFromEnv("DEFAULT_USER_QUOTA_BYTES", 2 * 1024 * 1024 * 1024);
  const maxUploadBytes = intFromEnv("MAX_UPLOAD_BYTES", 512 * 1024 * 1024);
  const fileTtlDays = intFromEnv("FILE_TTL_DAYS", 60);
  const uploadTicketTtlMinutes = intFromEnv("UPLOAD_TICKET_TTL_MINUTES", 60);
  const notifyExpiryDays = intListFromEnv("NOTIFY_EXPIRY_DAYS", [7, 3]);

  return {
    appBaseUrl,
    corsOrigins,
    firebaseWeb: {
      apiKey: raw("FIREBASE_API_KEY") ?? "",
      authDomain: raw("FIREBASE_AUTH_DOMAIN") ?? "",
      databaseURL: databaseUrl,
      projectId,
      storageBucket: raw("FIREBASE_STORAGE_BUCKET") ?? "",
      messagingSenderId: raw("FIREBASE_MESSAGING_SENDER_ID") ?? "",
      appId: raw("FIREBASE_APP_ID") ?? "",
    },
    adminClientEmail: clientEmail,
    adminPrivateKey,
    projectId,
    databaseUrl,
    apiSecretKey,
    credentialsEncryptionKey,
    cronSecret: raw("CRON_SECRET"),
    googleOAuthClientId,
    googleOAuthClientSecret,
    googleOAuthScopes,
    defaultUserQuotaBytes,
    maxUploadBytes,
    fileTtlDays,
    notifyExpiryDays,
    uploadTicketTtlMinutes,
    adminEmails: (raw("ADMIN_EMAILS") ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    appVersionDefault: raw("APP_VERSION") ?? "1.0.0",
  };
}

/**
 * Public-safe subset used by the admin login page. Only the Firebase *web*
 * configuration is exposed — never the Admin SDK credentials.
 */
export function publicFirebaseWebConfig(): FirebaseWebConfig {
  return {
    apiKey: raw("FIREBASE_API_KEY") ?? "",
    authDomain: raw("FIREBASE_AUTH_DOMAIN") ?? "",
    databaseURL: raw("FIREBASE_DATABASE_URL") ?? "",
    projectId: raw("FIREBASE_PROJECT_ID") ?? "kotha-bolbo-aso",
    storageBucket: raw("FIREBASE_STORAGE_BUCKET") ?? "",
    messagingSenderId: raw("FIREBASE_MESSAGING_SENDER_ID") ?? "",
    appId: raw("FIREBASE_APP_ID") ?? "",
  };
}
