import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError, loadConfig, missingConfigGroups, publicFirebaseWebConfig } from "@/lib/config";

const ENV_KEYS = [
  "FIREBASE_PROJECT_ID",
  "FIREBASE_CLIENT_EMAIL",
  "FIREBASE_PRIVATE_KEY",
  "FIREBASE_DATABASE_URL",
  "FIREBASE_API_KEY",
  "FIREBASE_AUTH_DOMAIN",
  "API_SECRET_KEY",
  "CREDENTIALS_ENCRYPTION_KEY",
  "GOOGLE_OAUTH_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "MAX_UPLOAD_BYTES",
  "DEFAULT_USER_QUOTA_BYTES",
  "FILE_TTL_DAYS",
  "NOTIFY_EXPIRY_DAYS",
  "ADMIN_EMAILS",
  "CRON_SECRET",
  "CORS_ORIGINS",
  "APP_BASE_URL",
];

function clearEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
}

describe("config", () => {
  beforeEach(() => {
    clearEnv();
    process.env.FIREBASE_PROJECT_ID = "kotha-bolbo-aso";
    process.env.FIREBASE_CLIENT_EMAIL = "svc@kotha-bolbo-aso.iam.gserviceaccount.com";
    process.env.FIREBASE_PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n";
    process.env.FIREBASE_DATABASE_URL = "https://kotha-bolbo-aso-default-rtdb.firebaseio.com";
    process.env.API_SECRET_KEY = "a".repeat(40);
  });
  afterEach(clearEnv);

  it("loads a full configuration", () => {
    const c = loadConfig();
    expect(c.projectId).toBe("kotha-bolbo-aso");
    expect(c.defaultUserQuotaBytes).toBe(2 * 1024 * 1024 * 1024);
    expect(c.fileTtlDays).toBe(60);
    expect(c.notifyExpiryDays).toEqual([7, 3]);
  });

  it("converts escaped newlines in the private key", () => {
    const c = loadConfig();
    expect(c.adminPrivateKey).toContain("\n");
    expect(c.adminPrivateKey).not.toContain("\\n");
  });

  it("reports missing variable NAMES only, never values", () => {
    delete process.env.FIREBASE_PRIVATE_KEY;
    delete process.env.API_SECRET_KEY;
    try {
      loadConfig();
      expect.unreachable("should throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const err = e as ConfigError;
      expect(err.missing).toContain("FIREBASE_PRIVATE_KEY");
      expect(err.missing).toContain("API_SECRET_KEY (min 32 chars)");
      expect(err.message).not.toContain("kotha-bolbo-aso.iam.gserviceaccount.com");
    }
  });

  it("rejects a short API_SECRET_KEY", () => {
    process.env.API_SECRET_KEY = "short";
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  it("rejects a malformed encryption key", () => {
    process.env.CREDENTIALS_ENCRYPTION_KEY = "not-hex";
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  it("parses integer and list overrides", () => {
    process.env.MAX_UPLOAD_BYTES = "1048576";
    process.env.NOTIFY_EXPIRY_DAYS = "5,1";
    process.env.ADMIN_EMAILS = " Admin@Example.com ,, ";
    const c = loadConfig();
    expect(c.maxUploadBytes).toBe(1048576);
    expect(c.notifyExpiryDays).toEqual([5, 1]);
    expect(c.adminEmails).toEqual(["admin@example.com"]);
  });

  it("exposes only public web config", () => {
    process.env.FIREBASE_API_KEY = "public-key";
    const pub = publicFirebaseWebConfig();
    expect(pub.apiKey).toBe("public-key");
    expect(pub.projectId).toBe("kotha-bolbo-aso");
    expect(JSON.stringify(pub)).not.toContain("PRIVATE");
  });

  it("missingConfigGroups lists unset server groups", () => {
    delete process.env.FIREBASE_DATABASE_URL;
    const missing = missingConfigGroups();
    expect(missing).toContain("FIREBASE_DATABASE_URL");
  });
});
