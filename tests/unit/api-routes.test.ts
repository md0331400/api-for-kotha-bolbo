import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { MemoryStore } from "@/lib/db/memory-store";
import { FakeDriveProvider } from "./fake-drive-provider";

// ---- module mocks -----------------------------------------------------------

vi.mock("@/lib/firebase-admin", () => {
  return {
    requireAdminSdk: () => ({
      app: {},
      auth: {
        verifyIdToken: async (token: string) => {
          if (token === "bad-token") {
            const e = new Error("invalid token");
            (e as { code?: string }).code = "auth/argument-error";
            throw e;
          }
          if (token === "expired-token") {
            const e = new Error("expired");
            (e as { code?: string }).code = "auth/id-token-expired";
            throw e;
          }
          if (!token.startsWith("uid:")) {
            const e = new Error("invalid");
            (e as { code?: string }).code = "auth/argument-error";
            throw e;
          }
          const [uid, email] = token.slice(4).split("|");
          return { uid, email: email ?? null, name: "Test User" };
        },
      },
      db: {},
      messaging: { sendEachForMulticast: async () => ({ successCount: 0, failureCount: 0 }) },
    }),
    firebaseConfigError: () => null,
    resetAdminSdk: async () => undefined,
  };
});

const fakeProvider = new FakeDriveProvider();

vi.mock("@/lib/storage/pool", () => {
  return {
    getDriveProvider: async () => fakeProvider,
    createResumableOnPool: async () => ({
      accountId: "drv_test",
      managedFolderId: "folder-1",
      uploadUrl: "https://fake.invalid/resumable/1",
      expiresAt: Date.now() + 55 * 60_000,
      headers: { "Content-Type": "application/octet-stream" },
    }),
    encryptRefreshToken: (_c: unknown, t: string) => t,
    decryptRefreshToken: (_c: unknown, t: string) => t,
    selectEligibleAccounts: async () => [],
    recordAccountSuccess: async () => undefined,
    recordAccountError: async () => undefined,
    clearTokenCache: () => undefined,
  };
});

import { setStore } from "@/lib/api/store-singleton";
import { GET as healthGet } from "@/app/api/v1/health/route";
import { GET as versionGet } from "@/app/api/v1/app/version/route";
import { GET as quotaGet } from "@/app/api/v1/storage/quota/route";
import { GET as filesListGet } from "@/app/api/v1/storage/files/route";
import { POST as ticketPost } from "@/app/api/v1/storage/upload-ticket/route";
import { POST as confirmPost } from "@/app/api/v1/storage/upload-confirm/route";
import { DELETE as fileDelete, GET as fileGet } from "@/app/api/v1/storage/files/[id]/route";
import { GET as statsGet } from "@/app/api/v1/admin/stats/route";
import { PUT as versionPut } from "@/app/api/v1/admin/app-version/route";
import { GET as cleanupGet, POST as cleanupPost } from "@/app/api/v1/jobs/cleanup/route";
import { GET as sessionGet } from "@/app/api/v1/admin/session/route";

// ---- helpers ----------------------------------------------------------------

let store: MemoryStore;

function req(path: string, init?: RequestInit & { token?: string }): NextRequest {
  const headers = new Headers(init?.headers);
  if (init?.token) headers.set("Authorization", `Bearer ${init.token}`);
  const { token: _token, ...rest } = init ?? {};
  return new NextRequest(`http://localhost${path}`, {
    ...rest,
    headers,
  } as ConstructorParameters<typeof NextRequest>[1]);
}

async function json(res: Response) {
  return JSON.parse(await res.text());
}

beforeAll(() => {
  process.env.FIREBASE_PROJECT_ID = "kotha-bolbo-aso";
  process.env.FIREBASE_CLIENT_EMAIL = "svc@example.com";
  process.env.FIREBASE_PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----";
  process.env.FIREBASE_DATABASE_URL = "https://example.firebaseio.com";
  process.env.API_SECRET_KEY = "s".repeat(40);
  process.env.APP_BASE_URL = "http://localhost";
  process.env.CRON_SECRET = "cron-secret-value-1234567890";
});

beforeEach(async () => {
  store = new MemoryStore();
  setStore(store);
  fakeProvider.objects.clear();
  fakeProvider.deletedIds = [];
  fakeProvider.failNext = null;
  // setup app and api key for tests
  await store.setDriveFolder("drv_test", "sys_Applications", "folder_apps");
  await store.createApp({ id: "app_test", name: "Test App", packageName: "com.test.app", status: "enabled", createdAt: Date.now() });
  await store.createApiKey({ id: "ak_test", appId: "app_test", name: "test", subjectUid: "user-1", scopes: ["storage:write", "storage:read"], secretHash: "test", prefix: "kb_test", status: "active", createdAt: Date.now(), createdBy: "admin", createdByEmail: null, lastUsedAt: null, revokedAt: null, revokedBy: null, expiresAt: null });
});

// ---- tests ------------------------------------------------------------------

describe("health and version (public)", () => {
  it("health reports ok without exposing secrets", async () => {
    const res = await healthGet(req("/api/v1/health"));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.status).toBe("ok");
    const text = JSON.stringify(body);
    expect(text).not.toContain("PRIVATE");
    expect(text).not.toContain("s".repeat(40));
  });

  it("app version is explicitly unpublished when nothing is published", async () => {
    const res = await versionGet(req("/api/v1/app/version"));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.data.isPublished).toBe(false);
    expect(body.data.currentVersion).toBeNull();
  });

  it("app version reflects published metadata after an admin publishes", async () => {
    await store.grantAdmin("admin-1", "admin@example.com", "test");
    const put = await versionPut(
      req("/api/v1/admin/app-version", {
        method: "PUT",
        token: "uid:admin-1|admin@example.com",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentVersion: "1.2.0",
          minSupportedVersion: "1.0.0",
          updateUrl: "https://example.com/apk",
          forceUpdate: false,
          releaseNotes: "First release",
        }),
      })
    );
    expect(put.status).toBe(200);
    const res = await versionGet(req("/api/v1/app/version"));
    const body = await json(res);
    expect(body.data.isPublished).toBe(true);
    expect(body.data.currentVersion).toBe("1.2.0");
  });
});

describe("authentication and authorization", () => {
  it("rejects missing tokens", async () => {
    const res = await quotaGet(req("/api/v1/storage/quota"));
    expect(res.status).toBe(401);
    const body = await json(res);
    expect(body.error.code).toBe("UNAUTHENTICATED");
    expect(body.error.requestId).toBeTruthy();
  });

  it("rejects invalid and expired tokens with distinct codes", async () => {
    const bad = await quotaGet(req("/api/v1/storage/quota", { token: "bad-token" }));
    expect(bad.status).toBe(401);
    expect((await json(bad)).error.code).toBe("TOKEN_INVALID");
    const expired = await quotaGet(req("/api/v1/storage/quota", { token: "expired-token" }));
    expect(expired.status).toBe(401);
    expect((await json(expired)).error.code).toBe("TOKEN_EXPIRED");
  });

  it("denies admin endpoints for non-admin users", async () => {
    const res = await statsGet(req("/api/v1/admin/stats", { token: "uid:user-1|u@example.com" }));
    expect(res.status).toBe(403);
    expect((await json(res)).error.code).toBe("FORBIDDEN");
  });

  it("grants admin via ADMIN_EMAILS bootstrap (documented first-run path)", async () => {
    process.env.ADMIN_EMAILS = "boss@example.com";
    try {
      const res = await sessionGet(req("/api/v1/admin/session", { token: "uid:uid-9|boss@example.com" }));
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.data.isAdmin).toBe(true);
      expect(await store.isAdmin("uid-9")).toBe(true);
    } finally {
      delete process.env.ADMIN_EMAILS;
    }
  });

  it("prevents cross-user file access", async () => {
    // Seed a file for user-1. The mocked pool assigns accountId "drv_test".
    const acct = await store.createDriveAccount({ accountEmail: "s@x.y", displayName: null, scope: "x" });
    store.driveAccounts.delete(acct.id);
    store.driveAccounts.set("drv_test", { ...acct, id: "drv_test", managedFolderId: "folder-1" });
    await store.saveDriveToken({ accountId: "drv_test", refreshToken: "rt", scope: "x", obtainedAt: Date.now() });
    const ticket = await ticketPost(
      req("/api/v1/storage/upload-ticket", {
        method: "POST",
        token: "uid:user-1|u1@example.com",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          category: "photo",
          name: "cat.png",
          mimeType: "image/png",
          sizeBytes: 100,
          idempotencyKey: "key-cross-user-1",
        }),
      })
    );
    expect(ticket.status).toBe(200);
    const ticketBody = await json(ticket);
    const providerFileId = fakeProvider.completeUpload(ticketBody.data.upload.url, {
      name: "cat.png",
      mimeType: "image/png",
      sizeBytes: 100,
      parentId: "folder-1",
    });
    const confirm = await confirmPost(
      req("/api/v1/storage/upload-confirm", {
        method: "POST",
        token: "uid:user-1|u1@example.com",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uploadId: ticketBody.data.uploadId, providerFileId }),
      })
    );
    expect(confirm.status).toBe(200);
    const fileId = (await json(confirm)).data.file.id;

    // Attacker cannot read or delete it.
    const attackerGet = await fileGet(
      req(`/api/v1/storage/files/${fileId}`, { token: "uid:user-2|u2@example.com" }),
      { params: { id: fileId } }
    );
    expect(attackerGet.status).toBe(403);
    const attackerDelete = await fileDelete(
      req(`/api/v1/storage/files/${fileId}`, { method: "DELETE", token: "uid:user-2|u2@example.com" }),
      { params: { id: fileId } }
    );
    expect(attackerDelete.status).toBe(403);

    // Owner can read and delete.
    const ownerGet = await fileGet(
      req(`/api/v1/storage/files/${fileId}`, { token: "uid:user-1|u1@example.com" }),
      { params: { id: fileId } }
    );
    expect(ownerGet.status).toBe(200);
    const ownerDelete = await fileDelete(
      req(`/api/v1/storage/files/${fileId}`, { method: "DELETE", token: "uid:user-1|u1@example.com" }),
      { params: { id: fileId } }
    );
    expect(ownerDelete.status).toBe(200);
    expect((await json(ownerDelete)).data.status).toBe("deleted");
  });
});

describe("upload flow", () => {
  async function asUser(path: string, token: string, body: unknown, method = "POST") {
    return req(path, {
      method,
      token,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("returns an empty quota for a fresh user (real zeros, no fake data)", async () => {
    const res = await quotaGet(req("/api/v1/storage/quota", { token: "uid:fresh|f@example.com" }));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.data.usedBytes).toBe(0);
    expect(body.data.reservedBytes).toBe(0);
    expect(body.data.fileCount).toBe(0);
    expect(body.data.remainingBytes).toBe(2 * 1024 * 1024 * 1024);
    expect(body.data.categories).toEqual({ chat: 0, voice: 0, photo: 0, video: 0, other: 0 });
  });

  it("validates input (size, MIME/category, name)", async () => {
    const oversize = await ticketPost(
      await asUser("/api/v1/storage/upload-ticket", "uid:u1|u@example.com", {
        category: "photo",
        name: "big.png",
        mimeType: "image/png",
        sizeBytes: 900 * 1024 * 1024,
        idempotencyKey: "key-oversize-1",
      })
    );
    expect(oversize.status).toBe(413);

    const badMime = await ticketPost(
      await asUser("/api/v1/storage/upload-ticket", "uid:u1|u@example.com", {
        category: "voice",
        name: "x.png",
        mimeType: "image/png",
        sizeBytes: 10,
        idempotencyKey: "key-badmime-1",
      })
    );
    expect(badMime.status).toBe(422);

    const badName = await ticketPost(
      await asUser("/api/v1/storage/upload-ticket", "uid:u1|u@example.com", {
        category: "other",
        name: "../evil",
        mimeType: "application/pdf",
        sizeBytes: 10,
        idempotencyKey: "key-badname-1",
      })
    );
    expect(badName.status).toBe(422);
  });

  it("issues a ticket, confirms, and enforces quota + idempotency", async () => {
    const token = "uid:u1|u@example.com";
    const ticketReq = () =>
      asUser("/api/v1/storage/upload-ticket", token, {
        category: "photo",
        name: "cat.png",
        mimeType: "image/png",
        sizeBytes: 100,
        idempotencyKey: "key-idem-upload",
      });

    const t1 = await ticketPost(await ticketReq());
    expect(t1.status).toBe(200);
    const b1 = await json(t1);
    expect(b1.data.upload.url).toContain("fake.invalid");
    expect(b1.data.reservedBytes).toBe(100);

    // Same idempotency key → same session, reservation not duplicated.
    const t2 = await ticketPost(await ticketReq());
    const b2 = await json(t2);
    expect(b2.data.reused).toBe(true);
    expect(b2.data.uploadId).toBe(b1.data.uploadId);
    let quota = await json(await quotaGet(req("/api/v1/storage/quota", { token })));
    expect(quota.data.reservedBytes).toBe(100);

    // Upload at the provider (client → Google), then confirm.
    const providerFileId = fakeProvider.completeUpload(b1.data.upload.url, {
      name: "cat.png",
      mimeType: "image/png",
      sizeBytes: 100,
      parentId: "folder-1",
    });
    const confirm = await confirmPost(
      await asUser("/api/v1/storage/upload-confirm", token, {
        uploadId: b1.data.uploadId,
        providerFileId,
      })
    );
    expect(confirm.status).toBe(200);
    const cb = await json(confirm);
    expect(cb.data.file.sizeBytes).toBe(100);
    expect(cb.data.file.category).toBe("photo");
    // 60-day expiry.
    const days = (Date.parse(cb.data.file.expiresAt) - Date.parse(cb.data.file.createdAt)) / 86_400_000;
    expect(days).toBeCloseTo(60, 5);

    // Confirm again is idempotent.
    const confirm2 = await confirmPost(
      await asUser("/api/v1/storage/upload-confirm", token, {
        uploadId: b1.data.uploadId,
        providerFileId,
      })
    );
    expect((await json(confirm2)).data.reused).toBe(true);

    quota = await json(await quotaGet(req("/api/v1/storage/quota", { token })));
    expect(quota.data.usedBytes).toBe(100);
    expect(quota.data.reservedBytes).toBe(0);
    expect(quota.data.fileCount).toBe(1);

    // File appears in the owner's list and nowhere else.
    const list = await filesListGet(req("/api/v1/storage/files", { token }));
    const listBody = await json(list);
    expect(listBody.data).toHaveLength(1);
    expect(listBody.pagination.total).toBe(1);
  });

  it("rejects confirming a file that is larger than reserved", async () => {
    const token = "uid:u1|u@example.com";
    const t = await ticketPost(
      await asUser("/api/v1/storage/upload-ticket", token, {
        category: "other",
        name: "a.pdf",
        mimeType: "application/pdf",
        sizeBytes: 50,
        idempotencyKey: "key-size-mismatch",
      })
    );
    const tb = await json(t);
    const providerFileId = fakeProvider.completeUpload(tb.data.upload.url, {
      name: "a.pdf",
      mimeType: "application/pdf",
      sizeBytes: 500,
      parentId: "folder-1",
    });
    // The fake reports the actual (larger) size on meta lookup:
    const confirm = await confirmPost(
      await asUser("/api/v1/storage/upload-confirm", token, {
        uploadId: tb.data.uploadId,
        providerFileId,
      })
    );
    expect(confirm.status).toBe(400);
    const quota = await json(await quotaGet(req("/api/v1/storage/quota", { token })));
    expect(quota.data.reservedBytes).toBe(0);
  });

  it("rejects uploads for restricted users", async () => {
    const token = "uid:restr|r@example.com";
    await store.upsertUserOnLogin({ uid: "restr", email: "r@example.com", displayName: null, photoURL: null });
    await store.setUserFields("restr", { restricted: true });
    const res = await ticketPost(
      await asUser("/api/v1/storage/upload-ticket", token, {
        category: "chat",
        name: "a.txt",
        mimeType: "text/plain",
        sizeBytes: 5,
        idempotencyKey: "key-restricted-1",
      })
    );
    expect(res.status).toBe(403);
  });
});

describe("scheduled cleanup endpoint", () => {
  it("rejects anonymous and wrong-secret callers", async () => {
    const anon = await cleanupPost(req("/api/v1/jobs/cleanup", { method: "POST" }));
    expect(anon.status).toBe(401);
    const wrong = await cleanupPost(
      req("/api/v1/jobs/cleanup", { method: "POST", token: "wrong-secret-0000000000" })
    );
    expect([401, 403]).toContain(wrong.status);
  });

  it("runs with the CRON_SECRET bearer and records a run", async () => {
    const res = await cleanupPost(
      req("/api/v1/jobs/cleanup", { method: "POST", token: "cron-secret-value-1234567890" })
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.data.status).toBe("success");
    const runs = await store.listCleanupRuns(5);
    expect(runs).toHaveLength(1);
    expect(runs[0].triggeredBy).toBe("cron");
  });

  it("also accepts GET from the cron scheduler", async () => {
    const res = await cleanupGet(
      req("/api/v1/jobs/cleanup", { method: "GET", token: "cron-secret-value-1234567890" })
    );
    expect(res.status).toBe(200);
  });
});
