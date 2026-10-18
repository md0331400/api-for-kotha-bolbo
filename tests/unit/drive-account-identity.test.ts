import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { MemoryStore } from "@/lib/db/memory-store";
import { FakeDriveProvider } from "./fake-drive-provider";

// ---- module mocks -----------------------------------------------------------

vi.mock("@/lib/firebase-admin", () => ({
  requireAdminSdk: () => ({
    app: {},
    auth: {
      verifyIdToken: async (token: string) => {
        if (!token.startsWith("uid:")) throw Object.assign(new Error("invalid"), { code: "auth/argument-error" });
        return { uid: token.slice(4), email: null, name: null };
      },
    },
    db: {},
    messaging: {},
  }),
  firebaseConfigError: () => null,
  resetAdminSdk: async () => undefined,
}));

const fakeProvider = new FakeDriveProvider();
const providerFailures: Error[] = [];

vi.mock("@/lib/storage/pool", () => ({
  getDriveProvider: async () => {
    const e = providerFailures.shift();
    if (e) throw e;
    return fakeProvider;
  },
  createResumableOnPool: async () => {
    throw new Error("not used");
  },
  encryptRefreshToken: (_c: unknown, t: string) => `enc(${t})`,
  decryptRefreshToken: (_c: unknown, t: string) => t.replace(/^enc\((.*)\)$/, "$1"),
  selectEligibleAccounts: async () => [],
  recordAccountSuccess: async () => undefined,
  recordAccountError: async (store: { updateDriveAccount: (id: string, p: unknown) => Promise<unknown> }, id: string, message: string) => {
    await store.updateDriveAccount(id, { status: "error", lastErrorAt: Date.now(), lastErrorMessage: message });
  },
  clearTokenCache: () => undefined,
}));

type GoogleUser = { sub: string | null; email: string | null; name: string | null };
let googleUser: GoogleUser = { sub: "g-sub-1", email: "Support.AmiSayem@gmail.com", name: "Support" };
let nextRefreshToken: string | null = "rt-1";
let exchangeDelayMs = 0;

vi.mock("@/lib/storage/google-oauth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/storage/google-oauth")>()),
  buildAuthUrl: () => "https://accounts.google.com/o/oauth2/v2/auth?x=1",
  exchangeAuthorizationCode: async () => {
    if (exchangeDelayMs) await new Promise((r) => setTimeout(r, exchangeDelayMs));
    return {
      accessToken: "at",
      expiresAt: Date.now() + 3600_000,
      refreshToken: nextRefreshToken,
      scope: "https://www.googleapis.com/auth/drive.file",
      idToken: undefined,
    };
  },
  refreshAccessToken: async () => ({ accessToken: "at2", expiresAt: Date.now() + 3600_000, refreshToken: "rt", scope: "" }),
  fetchGoogleIdentity: async () => ({ ...googleUser }),
}));

import { setStore } from "@/lib/api/store-singleton";
import { GET as callbackGet } from "@/app/api/v1/admin/drive-accounts/callback/route";
import { GET as duplicatesGet } from "@/app/api/v1/admin/drive-accounts/duplicates/route";
import { createOAuthState } from "@/lib/storage/oauth-state";
import { findDuplicateGroups, normalizeEmail, resolveOrCreateDriveAccount } from "@/lib/storage/account-identity";
import { identityFromIdToken } from "@/lib/storage/google-oauth";

// ---- helpers ----------------------------------------------------------------

let store: MemoryStore;
const SECRET = "s".repeat(40);

function callback(code = "code-1"): Promise<Response> {
  const state = createOAuthState(SECRET, "admin-1", `n-${Math.random()}`);
  const url = `http://localhost/api/v1/admin/drive-accounts/callback?code=${code}&state=${encodeURIComponent(state)}`;
  return callbackGet(new NextRequest(url));
}

function redirectParams(res: Response): URLSearchParams {
  expect(res.status).toBe(302);
  return new URL(res.headers.get("location")!).searchParams;
}

beforeAll(() => {
  process.env.FIREBASE_PROJECT_ID = "kotha-bolbo-aso";
  process.env.FIREBASE_CLIENT_EMAIL = "svc@example.com";
  process.env.FIREBASE_PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----";
  process.env.FIREBASE_DATABASE_URL = "https://example.firebaseio.com";
  process.env.API_SECRET_KEY = SECRET;
  process.env.APP_BASE_URL = "http://localhost";
  process.env.GOOGLE_OAUTH_CLIENT_ID = "client-id";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = "client-secret";
});

beforeEach(async () => {
  store = new MemoryStore();
  setStore(store);
  await store.grantAdmin("admin-1", "admin@example.com", "test");
  googleUser = { sub: "g-sub-1", email: "Support.AmiSayem@gmail.com", name: "Support" };
  nextRefreshToken = "rt-1";
  exchangeDelayMs = 0;
  providerFailures.length = 0;
  fakeProvider.objects.clear();
});

// ---- unit: identity resolution -----------------------------------------------

describe("resolveOrCreateDriveAccount", () => {
  it("normalizes emails", () => {
    expect(normalizeEmail("  Foo@Example.COM ")).toBe("foo@example.com");
    expect(normalizeEmail("")).toBeNull();
    expect(normalizeEmail(null)).toBeNull();
  });

  it("creates one record for a new identity and indexes sub + email", async () => {
    const r = await resolveOrCreateDriveAccount(store, { sub: "g1", email: "A@x.y", name: "A" }, { scope: "s" });
    expect(r.created).toBe(true);
    expect(r.account.googleAccountId).toBe("g1");
    expect(r.account.normalizedEmail).toBe("a@x.y");
    expect(await store.getDriveIdentityOwner("sub:g1")).toBe(r.account.id);
    expect(await store.getDriveIdentityOwner("email:a@x.y")).toBe(r.account.id);
  });

  it("matches by Google account id even when the email changed", async () => {
    const first = await resolveOrCreateDriveAccount(store, { sub: "g1", email: "old@x.y", name: null }, { scope: "s" });
    const second = await resolveOrCreateDriveAccount(store, { sub: "g1", email: "new@x.y", name: null }, { scope: "s" });
    expect(second.created).toBe(false);
    expect(second.account.id).toBe(first.account.id);
    expect((await store.listDriveAccounts()).length).toBe(1);
  });

  it("matches legacy records (no googleAccountId) by normalized email and back-fills them", async () => {
    const legacy = await store.createDriveAccount({ accountEmail: "Support.AmiSayem@gmail.com", displayName: null, scope: "s" });
    await store.updateDriveAccount(legacy.id, { googleAccountId: null, normalizedEmail: null });
    const r = await resolveOrCreateDriveAccount(store, { sub: "g-sub-1", email: "support.amisayem@gmail.com", name: "S" }, { scope: "s" });
    expect(r.created).toBe(false);
    expect(r.account.id).toBe(legacy.id);
    expect(r.account.googleAccountId).toBe("g-sub-1");
    expect(await store.getDriveIdentityOwner("sub:g-sub-1")).toBe(legacy.id);
    expect((await store.listDriveAccounts()).length).toBe(1);
  });

  it("rejects identities without sub or email", async () => {
    await expect(resolveOrCreateDriveAccount(store, { sub: null, email: null, name: null }, { scope: "s" })).rejects.toThrow();
  });

  it("concurrent resolutions for the same identity converge on one record", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => resolveOrCreateDriveAccount(store, { sub: "g9", email: "nine@x.y", name: null }, { scope: "s" }))
    );
    const ids = new Set(results.map((r) => r.account.id));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect((await store.listDriveAccounts()).length).toBe(1);
  });

  it("reports (but does not merge) pre-existing duplicates", async () => {
    const a = await store.createDriveAccount({ accountEmail: "dup@x.y", displayName: null, scope: "s" });
    const b = await store.createDriveAccount({ accountEmail: "DUP@x.y", displayName: null, scope: "s" });
    const groups = findDuplicateGroups(await store.listDriveAccounts());
    expect(groups).toHaveLength(1);
    expect(groups[0].accountIds.sort()).toEqual([a.id, b.id].sort());
    const r = await resolveOrCreateDriveAccount(store, { sub: "gd", email: "dup@x.y", name: null }, { scope: "s" });
    expect(r.created).toBe(false);
    expect(r.conflicts).toHaveLength(1);
    expect((await store.listDriveAccounts()).length).toBe(2); // nothing deleted
  });
});

describe("identityFromIdToken", () => {
  function jwt(payload: Record<string, unknown>): string {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    return `${b64({ alg: "RS256" })}.${b64(payload)}.sig`;
  }
  it("accepts tokens for this client from Google and rejects others", () => {
    const ok = identityFromIdToken(jwt({ iss: "https://accounts.google.com", aud: "cid", sub: "s1", email: "e@x.y", email_verified: true }), "cid");
    expect(ok?.sub).toBe("s1");
    expect(identityFromIdToken(jwt({ iss: "https://evil.example", aud: "cid", sub: "s1" }), "cid")).toBeNull();
    expect(identityFromIdToken(jwt({ iss: "https://accounts.google.com", aud: "other", sub: "s1" }), "cid")).toBeNull();
    expect(identityFromIdToken("garbage", "cid")).toBeNull();
    const unverified = identityFromIdToken(jwt({ iss: "accounts.google.com", aud: "cid", sub: "s2", email: "e@x.y", email_verified: false }), "cid");
    expect(unverified?.email).toBeNull();
  });
});

// ---- route: OAuth callback -----------------------------------------------------

describe("OAuth callback duplicate protection", () => {
  it("connects a new account, stores the encrypted token, verifies it", async () => {
    const params = redirectParams(await callback());
    expect(params.get("connected")).toBe("1");
    expect(params.get("verified")).toBe("1");
    const accounts = await store.listDriveAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].googleAccountId).toBe("g-sub-1");
    expect(accounts[0].normalizedEmail).toBe("support.amisayem@gmail.com");
    expect(accounts[0].verified).toBe(true);
    expect((await store.getDriveToken(accounts[0].id))?.refreshToken).toBe("enc(rt-1)");
    expect(store.auditLogs.some((l) => l.action === "drive.connect.complete")).toBe(true);
    expect(JSON.stringify(store.auditLogs)).not.toContain("rt-1");
  });

  it("connecting the same Google account again (same sub) reuses the record and rotates the token", async () => {
    redirectParams(await callback());
    nextRefreshToken = "rt-2";
    googleUser = { ...googleUser, email: "support.amisayem@gmail.com" };
    const params = redirectParams(await callback("code-2"));
    expect(params.get("reconnected")).toBe("1");
    expect(params.get("connected")).toBeNull();
    const accounts = await store.listDriveAccounts();
    expect(accounts).toHaveLength(1);
    expect((await store.getDriveToken(accounts[0].id))?.refreshToken).toBe("enc(rt-2)");
    expect(store.auditLogs.some((l) => l.action === "drive.reconnect.complete")).toBe(true);
  });

  it("duplicate email with a different/missing sub still maps to the existing record", async () => {
    redirectParams(await callback());
    googleUser = { sub: null, email: "SUPPORT.AMISAYEM@GMAIL.COM", name: null };
    nextRefreshToken = "rt-3";
    const params = redirectParams(await callback("code-3"));
    expect(params.get("reconnected")).toBe("1");
    expect((await store.listDriveAccounts()).length).toBe(1);
  });

  it("reconnecting a disconnected account restores it without creating a new record", async () => {
    redirectParams(await callback());
    const [acct] = await store.listDriveAccounts();
    await store.deleteDriveToken(acct.id);
    await store.updateDriveAccount(acct.id, { status: "disconnected", verified: false, disabledReason: "Disconnected by administrator." });
    nextRefreshToken = "rt-4";
    const params = redirectParams(await callback("code-4"));
    expect(params.get("reconnected")).toBe("1");
    const after = await store.getDriveAccount(acct.id);
    expect(after?.status).toBe("enabled");
    expect(after?.verified).toBe(true);
    expect(after?.disabledReason).toBeNull();
    expect((await store.getDriveToken(acct.id))?.refreshToken).toBe("enc(rt-4)");
    expect((await store.listDriveAccounts()).length).toBe(1);
  });

  it("keeps an admin-disabled account disabled on reconnect (only credentials refreshed)", async () => {
    redirectParams(await callback());
    const [acct] = await store.listDriveAccounts();
    await store.updateDriveAccount(acct.id, { status: "disabled", disabledReason: "maintenance" });
    nextRefreshToken = "rt-5";
    redirectParams(await callback("code-5"));
    const after = await store.getDriveAccount(acct.id);
    expect(after?.status).toBe("disabled");
    expect(after?.disabledReason).toBe("maintenance");
    expect((await store.getDriveToken(acct.id))?.refreshToken).toBe("enc(rt-5)");
  });

  it("never overwrites stored credentials when Google returns no refresh token", async () => {
    redirectParams(await callback());
    const [acct] = await store.listDriveAccounts();
    nextRefreshToken = null;
    const params = redirectParams(await callback("code-6"));
    expect(params.get("error")).toMatch(/refresh token/);
    expect((await store.getDriveToken(acct.id))?.refreshToken).toBe("enc(rt-1)");
    expect((await store.listDriveAccounts()).length).toBe(1);
  });

  it("concurrent callbacks for the same Google account create exactly one record", async () => {
    exchangeDelayMs = 5;
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => callback(`code-c${i}`)));
    const flags = results.map((r) => {
      const p = redirectParams(r);
      return p.get("connected") === "1" ? "connected" : p.get("reconnected") === "1" ? "reconnected" : "error";
    });
    expect(flags.filter((f) => f === "connected")).toHaveLength(1);
    expect(flags.filter((f) => f === "error")).toHaveLength(0);
    expect((await store.listDriveAccounts()).length).toBe(1);
    expect(store.driveIdentities.size).toBe(2);
  });

  it("legacy duplicate records are preserved and surfaced by the duplicates endpoint", async () => {
    const a = await store.createDriveAccount({ accountEmail: "support.amisayem@gmail.com", displayName: null, scope: "s" });
    const b = await store.createDriveAccount({ accountEmail: "support.amisayem@gmail.com", displayName: null, scope: "s" });
    await store.updateDriveAccount(a.id, { googleAccountId: null, normalizedEmail: null, fileCount: 3 });
    await store.updateDriveAccount(b.id, { googleAccountId: null, normalizedEmail: null });
    const params = redirectParams(await callback());
    expect(params.get("reconnected")).toBe("1");
    expect((await store.listDriveAccounts()).length).toBe(2);
    expect((await store.getDriveAccount(a.id))?.fileCount).toBe(3);

    const res = await duplicatesGet(
      new NextRequest("http://localhost/api/v1/admin/drive-accounts/duplicates", {
        headers: { Authorization: "Bearer uid:admin-1" },
      })
    );
    expect(res.status).toBe(200);
    const body = JSON.parse(await res.text());
    expect(body.data.total).toBe(1);
    expect(body.data.groups[0].accountIds.sort()).toEqual([a.id, b.id].sort());
    expect(body.data.groups[0].accounts.find((x: { id: string }) => x.id === a.id).fileCount).toBe(3);

    const denied = await duplicatesGet(
      new NextRequest("http://localhost/api/v1/admin/drive-accounts/duplicates", { headers: { Authorization: "Bearer uid:nobody" } })
    );
    expect(denied.status).toBe(403);
  });

  it("failed write test leaves the account connected but unverified (status error)", async () => {
    providerFailures.push(new Error("Drive 403 insufficient permissions"));
    const params = redirectParams(await callback());
    expect(params.get("connected")).toBe("1");
    expect(params.get("verified")).toBe("0");
    const [acct] = await store.listDriveAccounts();
    expect(acct.verified).toBe(false);
    expect(acct.status).toBe("error");
  });

  it("rejects callbacks with bad state or non-admin initiators", async () => {
    const bad = await callbackGet(new NextRequest("http://localhost/api/v1/admin/drive-accounts/callback?code=x&state=nope"));
    expect(redirectParams(bad).get("error")).toMatch(/state/i);
    const state = createOAuthState(SECRET, "not-admin", "n");
    const res = await callbackGet(new NextRequest(`http://localhost/api/v1/admin/drive-accounts/callback?code=x&state=${encodeURIComponent(state)}`));
    expect(redirectParams(res).get("error")).toMatch(/Administrator/);
    expect((await store.listDriveAccounts()).length).toBe(0);
  });
});
