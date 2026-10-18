import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { MemoryStore } from "@/lib/db/memory-store";

// ---- module mocks -----------------------------------------------------------

const knownFirebaseUsers = new Set<string>(["user-1", "user-2", "subject-1"]);

vi.mock("@/lib/firebase-admin", () => {
  return {
    requireAdminSdk: () => ({
      app: {},
      auth: {
        verifyIdToken: async (token: string) => {
          if (!token.startsWith("uid:")) {
            const e = new Error("invalid");
            (e as { code?: string }).code = "auth/argument-error";
            throw e;
          }
          const [uid, email] = token.slice(4).split("|");
          return { uid, email: email ?? null, name: "Test User" };
        },
        getUser: async (uid: string) => {
          if (knownFirebaseUsers.has(uid)) return { uid };
          const e = new Error("no user");
          (e as { code?: string }).code = "auth/user-not-found";
          throw e;
        },
      },
      db: {},
      messaging: { sendEachForMulticast: async () => ({ successCount: 0, failureCount: 0 }) },
    }),
    firebaseConfigError: () => null,
    resetAdminSdk: async () => undefined,
  };
});

vi.mock("@/lib/storage/pool", () => ({
  getDriveProvider: async () => {
    throw new Error("not used");
  },
  createResumableOnPool: async () => {
    throw new Error("not used");
  },
  encryptRefreshToken: (_c: unknown, t: string) => t,
  decryptRefreshToken: (_c: unknown, t: string) => t,
  selectEligibleAccounts: async () => [],
  recordAccountSuccess: async () => undefined,
  recordAccountError: async () => undefined,
  clearTokenCache: () => undefined,
}));

import { setStore } from "@/lib/api/store-singleton";
import { GET as usersGet } from "@/app/api/v1/admin/users/route";
import { GET as filesGet } from "@/app/api/v1/admin/files/route";
import { GET as auditGet } from "@/app/api/v1/admin/audit-logs/route";
import { GET as jobsGet } from "@/app/api/v1/admin/jobs/cleanup/route";
import { GET as keysGet, POST as keysPost } from "@/app/api/v1/admin/api-keys/route";
import { DELETE as keyDelete, PATCH as keyPatch } from "@/app/api/v1/admin/api-keys/[id]/route";
import { GET as quotaGet } from "@/app/api/v1/storage/quota/route";
import { GET as storageFilesGet } from "@/app/api/v1/storage/files/route";
import { POST as ticketPost } from "@/app/api/v1/storage/upload-ticket/route";
import { GET as statsGet } from "@/app/api/v1/admin/stats/route";
import { generateApiKey, hashApiKey, verifyApiKey } from "@/lib/api/api-keys";
import { ApiError } from "@/lib/errors";

// ---- helpers ----------------------------------------------------------------

let store: MemoryStore;
const ADMIN = "uid:admin-1|admin@example.com";

function req(path: string, init?: RequestInit & { token?: string; apiKey?: string }): NextRequest {
  const headers = new Headers(init?.headers);
  if (init?.token) headers.set("Authorization", `Bearer ${init.token}`);
  if (init?.apiKey) headers.set("X-API-Key", init.apiKey);
  const { token: _t, apiKey: _k, ...rest } = init ?? {};
  return new NextRequest(`http://localhost${path}`, { ...rest, headers } as ConstructorParameters<typeof NextRequest>[1]);
}

async function json(res: Response) {
  return JSON.parse(await res.text());
}

function postJson(path: string, body: unknown, token = ADMIN) {
  return req(path, { method: "POST", token, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

beforeAll(() => {
  process.env.FIREBASE_PROJECT_ID = "kotha-bolbo-aso";
  process.env.FIREBASE_CLIENT_EMAIL = "svc@example.com";
  process.env.FIREBASE_PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----";
  process.env.FIREBASE_DATABASE_URL = "https://example.firebaseio.com";
  process.env.API_SECRET_KEY = "s".repeat(40);
  process.env.APP_BASE_URL = "http://localhost";
});

beforeEach(async () => {
  store = new MemoryStore();
  setStore(store);
  await store.grantAdmin("admin-1", "admin@example.com", "test");
});

// ---- Issue 1: admin list endpoints -------------------------------------------

describe("admin list endpoints return the documented paginated envelope", () => {
  it("users: data[] + pagination (empty database → total 0, not an error)", async () => {
    const res = await usersGet(req("/api/v1/admin/users?page=1&pageSize=20", { token: ADMIN }));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.pagination).toMatchObject({ page: 1, pageSize: 20, total: 0, totalPages: 1, hasMore: false });
  });

  it("users: lists real records with search and pagination", async () => {
    for (let i = 0; i < 25; i += 1) {
      await store.upsertUserOnLogin({ uid: `u-${i}`, email: `person${i}@example.com`, displayName: `Person ${i}`, photoURL: null });
    }
    const page2 = await json(await usersGet(req("/api/v1/admin/users?page=2&pageSize=20", { token: ADMIN })));
    expect(page2.data).toHaveLength(5);
    expect(page2.pagination.total).toBe(25);
    expect(page2.pagination.totalPages).toBe(2);
    const search = await json(await usersGet(req("/api/v1/admin/users?q=person7", { token: ADMIN })));
    expect(search.data).toHaveLength(1);
    expect(search.data[0].email).toBe("person7@example.com");
    expect(JSON.stringify(search)).not.toContain("password");
  });

  it("files: data[] + pagination with filters", async () => {
    const res = await filesGet(req("/api/v1/admin/files?status=confirmed&category=photo", { token: ADMIN }));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.data).toEqual([]);
    expect(body.pagination.total).toBe(0);
    const bad = await filesGet(req("/api/v1/admin/files?category=nope", { token: ADMIN }));
    expect(bad.status).toBe(422);
    expect((await json(bad)).error.code).toBe("VALIDATION_FAILED");
  });

  it("audit logs: data[] + pagination, newest first", async () => {
    await store.appendAudit({ actorUid: "a", actorEmail: null, action: "x.one", targetType: "t", targetId: "1", requestId: null, details: {}, at: 1 });
    await store.appendAudit({ actorUid: "a", actorEmail: null, action: "x.two", targetType: "t", targetId: "2", requestId: null, details: {}, at: 2 });
    const body = await json(await auditGet(req("/api/v1/admin/audit-logs?page=1&pageSize=25", { token: ADMIN })));
    expect(body.pagination.total).toBe(2);
    expect(body.data[0].action).toBe("x.two");
    expect(typeof body.data[0].at).toBe("string");
  });

  it("jobs: single-resource envelope with runs and pendingRetries", async () => {
    const body = await json(await jobsGet(req("/api/v1/admin/jobs/cleanup", { token: ADMIN })));
    expect(body.data).toEqual({ runs: [], pendingRetries: 0 });
  });

  it("all list endpoints reject unauthenticated, invalid, and non-admin callers with JSON errors", async () => {
    for (const [handler, path] of [
      [usersGet, "/api/v1/admin/users"],
      [filesGet, "/api/v1/admin/files"],
      [auditGet, "/api/v1/admin/audit-logs"],
      [jobsGet, "/api/v1/admin/jobs/cleanup"],
      [keysGet, "/api/v1/admin/api-keys"],
    ] as const) {
      const none = await handler(req(path));
      expect(none.status).toBe(401);
      expect((await json(none)).error.code).toBe("UNAUTHENTICATED");
      const bad = await handler(req(path, { token: "garbage" }));
      expect(bad.status).toBe(401);
      const user = await handler(req(path, { token: "uid:user-1|u@example.com" }));
      expect(user.status).toBe(403);
      expect((await json(user)).error.code).toBe("FORBIDDEN");
    }
  });

  it("reports missing server configuration as 503 CONFIG_MISSING instead of a crash", async () => {
    const saved = process.env.FIREBASE_DATABASE_URL;
    delete process.env.FIREBASE_DATABASE_URL;
    try {
      const res = await usersGet(req("/api/v1/admin/users", { token: ADMIN }));
      expect(res.status).toBe(503);
      const body = await json(res);
      expect(body.error.code).toBe("CONFIG_MISSING");
      expect(body.error.details.missing).toContain("FIREBASE_DATABASE_URL");
      expect(JSON.stringify(body)).not.toContain("PRIVATE KEY");
    } finally {
      process.env.FIREBASE_DATABASE_URL = saved;
    }
  });
});

// ---- Issue 4: API key management ----------------------------------------------

describe("API key primitives", () => {
  it("generates well-formed, unique keys and stores only a hash", () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a.rawKey).toMatch(/^kb_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/);
    expect(a.rawKey).not.toBe(b.rawKey);
    expect(a.keyId).toBe(`ak_${a.rawKey.split("_")[1]}`);
    expect(a.secretHash).toBe(hashApiKey(a.rawKey));
    expect(a.secretHash).toHaveLength(64);
    expect(a.prefix).not.toContain(a.rawKey.slice(-20));
  });

  it("verification is fail-closed", async () => {
    const g = generateApiKey();
    await store.createApiKey({
      id: g.keyId,
      name: "t",
      subjectUid: "user-1",
      scopes: ["storage:read"],
      secretHash: g.secretHash,
      prefix: g.prefix,
      status: "active",
      createdAt: Date.now(),
      createdBy: "admin-1",
      createdByEmail: null,
      lastUsedAt: null,
      revokedAt: null,
      revokedBy: null,
      expiresAt: null,
    });
    await expect(verifyApiKey(store, g.rawKey)).resolves.toMatchObject({ record: { id: g.keyId } });
    await expect(verifyApiKey(store, "nonsense")).rejects.toBeInstanceOf(ApiError);
    const tampered = g.rawKey.slice(0, -1) + (g.rawKey.endsWith("A") ? "B" : "A");
    await expect(verifyApiKey(store, tampered)).rejects.toMatchObject({ code: "TOKEN_INVALID" });
    await store.updateApiKey(g.keyId, { status: "revoked" });
    await expect(verifyApiKey(store, g.rawKey)).rejects.toMatchObject({ code: "TOKEN_INVALID" });
    await store.updateApiKey(g.keyId, { status: "active", expiresAt: Date.now() - 1 });
    await expect(verifyApiKey(store, g.rawKey)).rejects.toMatchObject({ code: "TOKEN_EXPIRED" });
  });
});

describe("admin API key management routes", () => {
  it("creates a key, returns the raw key once, and never persists it", async () => {
    const res = await keysPost(
      postJson("/api/v1/admin/api-keys", { name: "Backup worker", subjectUid: "subject-1", scopes: ["storage:read", "storage:write"] })
    );
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.data.rawKey).toMatch(/^kb_/);
    expect(body.data.key.status).toBe("active");
    expect(body.data.key.scopes).toEqual(["storage:read", "storage:write"]);
    expect(body.data.key.maskedKey).not.toBe(body.data.rawKey);
    expect(body.data.key).not.toHaveProperty("secretHash");

    const stored = await store.getApiKey(body.data.key.id);
    expect(stored?.secretHash).toBe(hashApiKey(body.data.rawKey));
    expect(JSON.stringify(stored)).not.toContain(body.data.rawKey);

    const list = await json(await keysGet(req("/api/v1/admin/api-keys", { token: ADMIN })));
    expect(list.data).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(body.data.rawKey);
    expect(JSON.stringify(list)).not.toContain(stored!.secretHash);

    const audit = store.auditLogs.find((l) => l.action === "apikey.create");
    expect(audit).toBeTruthy();
    expect(JSON.stringify(audit)).not.toContain(body.data.rawKey);
  });

  it("validates input: unknown subject, empty scopes, unknown scope, bad name", async () => {
    const unknownUser = await keysPost(postJson("/api/v1/admin/api-keys", { name: "x", subjectUid: "ghost", scopes: ["storage:read"] }));
    expect(unknownUser.status).toBe(422);
    const noScopes = await keysPost(postJson("/api/v1/admin/api-keys", { name: "x", subjectUid: "subject-1", scopes: [] }));
    expect(noScopes.status).toBe(422);
    const badScope = await keysPost(postJson("/api/v1/admin/api-keys", { name: "x", subjectUid: "subject-1", scopes: ["admin:*"] }));
    expect(badScope.status).toBe(422);
    const badName = await keysPost(postJson("/api/v1/admin/api-keys", { name: "<script>", subjectUid: "subject-1", scopes: ["storage:read"] }));
    expect(badName.status).toBe(422);
    const extra = await keysPost(postJson("/api/v1/admin/api-keys", { name: "x", subjectUid: "subject-1", scopes: ["storage:read"], secretHash: "x" }));
    expect(extra.status).toBe(422);
  });

  it("non-admins and API keys cannot manage keys", async () => {
    const res = await keysPost(postJson("/api/v1/admin/api-keys", { name: "x", subjectUid: "subject-1", scopes: ["storage:read"] }, "uid:user-1|u@example.com"));
    expect(res.status).toBe(403);
    const created = await json(await keysPost(postJson("/api/v1/admin/api-keys", { name: "x", subjectUid: "subject-1", scopes: ["storage:read"] })));
    const viaKey = await keysGet(req("/api/v1/admin/api-keys", { apiKey: created.data.rawKey }));
    expect(viaKey.status).toBe(403);
    expect((await json(viaKey)).error.message).toMatch(/Firebase ID token/);
  });

  it("revokes (idempotent), then deletes only revoked keys, with audit entries", async () => {
    const created = await json(await keysPost(postJson("/api/v1/admin/api-keys", { name: "x", subjectUid: "subject-1", scopes: ["storage:read"] })));
    const id = created.data.key.id;

    const delActive = await keyDelete(req(`/api/v1/admin/api-keys/${id}`, { method: "DELETE", token: ADMIN }), { params: { id } });
    expect(delActive.status).toBe(409);

    const revoke = await keyPatch(
      req(`/api/v1/admin/api-keys/${id}`, { method: "PATCH", token: ADMIN, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "revoke" }) }),
      { params: { id } }
    );
    expect(revoke.status).toBe(200);
    expect((await json(revoke)).data.status).toBe("revoked");
    const again = await keyPatch(
      req(`/api/v1/admin/api-keys/${id}`, { method: "PATCH", token: ADMIN, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "revoke" }) }),
      { params: { id } }
    );
    expect(again.status).toBe(200);
    expect(store.auditLogs.filter((l) => l.action === "apikey.revoke")).toHaveLength(1);

    // Revoked key is rejected on the client API.
    const use = await quotaGet(req("/api/v1/storage/quota", { apiKey: created.data.rawKey }));
    expect(use.status).toBe(401);

    const del = await keyDelete(req(`/api/v1/admin/api-keys/${id}`, { method: "DELETE", token: ADMIN }), { params: { id } });
    expect(del.status).toBe(200);
    expect(await store.getApiKey(id)).toBeNull();
    expect(store.auditLogs.find((l) => l.action === "apikey.delete")).toBeTruthy();

    const missing = await keyPatch(
      req(`/api/v1/admin/api-keys/${id}`, { method: "PATCH", token: ADMIN, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "revoke" }) }),
      { params: { id } }
    );
    expect(missing.status).toBe(404);
  });

  it("rate limits key creation per administrator", async () => {
    let limited = 0;
    for (let i = 0; i < 12; i += 1) {
      const res = await keysPost(postJson("/api/v1/admin/api-keys", { name: `k${i}`, subjectUid: "subject-1", scopes: ["storage:read"] }));
      if (res.status === 429) limited += 1;
      else expect(res.status).toBe(201);
    }
    expect(limited).toBe(2);
  });
});

describe("client authentication with API keys", () => {
  async function mint(scopes: string[], subjectUid = "subject-1"): Promise<string> {
    const res = await keysPost(postJson("/api/v1/admin/api-keys", { name: "client", subjectUid, scopes }));
    expect(res.status).toBe(201);
    return (await json(res)).data.rawKey;
  }

  it("acts as the subject user with the granted scopes", async () => {
    const key = await mint(["storage:read"]);
    const res = await quotaGet(req("/api/v1/storage/quota", { apiKey: key }));
    expect(res.status).toBe(200);
    expect(await store.getUser("subject-1")).toBeTruthy();
    const files = await storageFilesGet(req("/api/v1/storage/files", { apiKey: key }));
    expect(files.status).toBe(200);
    const rec = await store.getApiKey(`ak_${key.split("_")[1]}`);
    expect(rec?.lastUsedAt).toBeTypeOf("number");
  });

  it("enforces scopes", async () => {
    const readOnly = await mint(["storage:read"]);
    const ticket = await ticketPost(
      req("/api/v1/storage/upload-ticket", {
        method: "POST",
        apiKey: readOnly,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category: "photo", name: "a.png", mimeType: "image/png", sizeBytes: 10, idempotencyKey: "k-12345678" }),
      })
    );
    expect(ticket.status).toBe(403);
    const body = await json(ticket);
    expect(body.error.code).toBe("FORBIDDEN");
    expect(body.error.details.requiredScope).toBe("storage:write");
  });

  it("never grants admin access and rejects unknown/malformed keys", async () => {
    const key = await mint(["storage:read", "storage:write", "storage:delete", "notifications:write"]);
    const admin = await statsGet(req("/api/v1/admin/stats", { apiKey: key }));
    expect(admin.status).toBe(403);
    const unknown = await quotaGet(req("/api/v1/storage/quota", { apiKey: "kb_0123456789abcdef_" + "B".repeat(43) }));
    expect(unknown.status).toBe(401);
    expect((await json(unknown)).error.code).toBe("TOKEN_INVALID");
    const malformed = await quotaGet(req("/api/v1/storage/quota", { apiKey: "not-a-key" }));
    expect(malformed.status).toBe(401);
  });

  it("prefers the Firebase bearer token when both headers are present", async () => {
    const key = await mint(["storage:read"], "subject-1");
    const res = await quotaGet(req("/api/v1/storage/quota", { token: "uid:user-2|u2@example.com", apiKey: key }));
    expect(res.status).toBe(200);
    expect(await store.getUser("user-2")).toBeTruthy();
    expect(await store.getUser("subject-1")).toBeNull();
  });
});
