import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { MemoryStore } from "@/lib/db/memory-store";

// Mock Firebase Admin
vi.mock("@/lib/firebase-admin", () => ({
  requireAdminSdk: () => ({
    app: {},
    auth: {
      verifyIdToken: async (token: string) => {
        const [uid, email] = token.slice(4).split("|");
        return { uid, email: email ?? null, name: "Test" };
      },
    },
    db: {},
    messaging: { sendEachForMulticast: async () => ({ successCount: 0, failureCount: 0 }) },
  }),
  firebaseConfigError: () => null,
  resetAdminSdk: async () => undefined,
}));

vi.mock("@/lib/storage/pool", () => ({
  getDriveProvider: async () => ({
    ensureManagedFolder: async () => ({ id: "folder-1" }),
    testOperation: async () => undefined,
    getFileMeta: async () => null,
    deleteFile: async () => undefined,
  }),
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
}));

import { setStore } from "@/lib/api/store-singleton";
import { GET as statsGet } from "@/app/api/v1/admin/stats/route";
import { GET as auditGet } from "@/app/api/v1/admin/audit-logs/route";
import { GET as jobsGet } from "@/app/api/v1/admin/jobs/cleanup/route";
import { GET as driveListGet } from "@/app/api/v1/admin/drive-accounts/route";
import { GET as dupGet } from "@/app/api/v1/admin/drive-accounts/duplicates/route";
import { DELETE as driveDelete } from "@/app/api/v1/admin/drive-accounts/[id]/route";
import { findDuplicateGroups } from "@/lib/storage/account-identity";
import { safeISOString, safeISOStringNullable } from "@/lib/safe-date";
import { toPublicFile } from "@/lib/db/types";

function req(path: string, init?: RequestInit & { token?: string }): NextRequest {
  const headers = new Headers(init?.headers);
  if (init?.token) headers.set("Authorization", `Bearer ${init.token}`);
  const { token: _token, ...rest } = init ?? {};
  return new NextRequest(`http://localhost${path}`, { ...rest, headers } as ConstructorParameters<typeof NextRequest>[1]);
}
async function json(res: Response) {
  return JSON.parse(await res.text());
}

let store: MemoryStore;

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
  await store.grantAdmin("admin-1", "admin@example.com", "test");
});

describe("regression: safe date handling prevents internal errors", () => {
  it("safeISOString never throws and returns null for missing/invalid (not misleading now)", () => {
    expect(() => safeISOString(undefined)).not.toThrow();
    expect(() => safeISOString(null as unknown as number)).not.toThrow();
    expect(() => safeISOString("not-a-date")).not.toThrow();
    expect(() => safeISOString(NaN)).not.toThrow();
    // Missing historical timestamps must NOT become \"now\" — they must be null
    expect(safeISOString(undefined)).toBeNull();
    expect(safeISOString(null)).toBeNull();
    expect(safeISOString("")).toBeNull();
    expect(safeISOString("not-a-date")).toBeNull();
    expect(safeISOString(NaN)).toBeNull();
    expect(safeISOStringNullable(null)).toBeNull();
    expect(safeISOStringNullable(undefined)).toBeNull();
    expect(safeISOStringNullable(0)).toBe("1970-01-01T00:00:00.000Z");
    expect(safeISOString(0)).toBe("1970-01-01T00:00:00.000Z");
    expect(safeISOString(Date.now())).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("toPublicFile returns null for missing timestamps instead of now", () => {
    const fake = {
      id: "file_x",
      category: "photo" as const,
      name: "a.png",
      mimeType: "image/png",
      sizeBytes: 100,
      createdAt: undefined as unknown as number,
      expiresAt: null as unknown as number,
      status: "confirmed" as const,
      providerAccountId: "drv_1",
      providerFileId: "p1",
      uid: "u1",
      uploadId: "up_1",
    } as unknown as import("@/lib/db/types").FileRecord;
    const pub = toPublicFile(fake, Date.now());
    expect(pub.createdAt).toBeNull();
    expect(pub.expiresAt).toBeNull();
    expect(pub.daysUntilExpiry).toBeNull();
  });

  it("stats endpoint tolerates corrupted drive accounts, users, and upload sessions", async () => {
    const now = Date.now();
    (store as unknown as { driveAccounts: Map<string, unknown> }).driveAccounts.set("drv_corrupt", {
      id: "drv_corrupt",
      accountEmail: "bad@example.com",
      displayName: null,
      status: "enabled",
      verified: false,
      connectedAt: undefined,
      updatedAt: null,
      lastSuccessAt: null,
      lastErrorAt: undefined,
      lastErrorMessage: null,
      fileCount: undefined as unknown as number,
      totalBytes: null as unknown as number,
      quotaInfo: null,
      managedFolderId: null,
      disabledReason: null,
    });
    store.users.set("user-corrupt", {
      uid: "user-corrupt",
      email: "c@example.com",
      displayName: null,
      photoURL: null,
      quotaBytes: undefined as unknown as number,
      usedBytes: 0,
      reservedBytes: 0,
      fileCount: 0,
      restricted: false,
      createdAt: undefined as unknown as number,
      updatedAt: null as unknown as number,
      lastLoginAt: now,
    } as unknown as import("@/lib/db/types").UserRecord);
    store.uploads.set("up_bad", {
      id: "up_bad",
      uid: "user-1",
      appId: null,
      category: "photo",
      name: "x.png",
      mimeType: "image/png",
      expectedBytes: 100,
      reservedBytes: 100,
      status: "released" as const,
      idempotencyKey: "k",
      providerAccountId: null,
      providerSessionUrl: null,
      providerFileId: null,
      fileId: "file_bad",
      createdAt: now,
      ticketExpiresAt: now + 1000,
      updatedAt: undefined as unknown as number,
      error: "bad",
    } as unknown as import("@/lib/db/types").UploadSession);
    store.cleanupRuns.set("run_bad", {
      id: "run_bad",
      startedAt: undefined as unknown as number,
      finishedAt: null,
      status: "success" as const,
      scanned: 1,
      deleted: 0,
      reservationReleased: 0,
      notified: 0,
      failed: 0,
      errors: null as unknown as Array<{ message: string }>,
      triggeredBy: "cron",
    } as unknown as import("@/lib/db/types").CleanupRunRecord);

    const res = await statsGet(req("/api/v1/admin/stats", { token: "uid:admin-1|admin@example.com" }));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.data.users.total).toBeGreaterThanOrEqual(1);
    expect(body.data.driveAccounts.total).toBeGreaterThanOrEqual(1);
    // Corrupted updatedAt must be null, not now
    const failed = body.data.recentFailedUploads.find((u: { uploadId: string }) => u.uploadId === "up_bad");
    if (failed) expect(failed.updatedAt).toBeNull();
    expect(body.error).toBeUndefined();
  });

  it("audit-logs endpoint tolerates missing at and null records", async () => {
    store.auditLogs = [
      {
        id: "log_bad",
        at: undefined as unknown as number,
        actorUid: "admin-1",
        actorEmail: "admin@example.com",
        action: "test.bad",
        targetType: "user",
        targetId: "uid",
        requestId: null,
        details: null as unknown as Record<string, unknown>,
      } as unknown as import("@/lib/db/types").AuditLogRecord,
      {
        id: "log_null_action",
        at: Date.now(),
        actorUid: null,
        actorEmail: null,
        action: null as unknown as string,
        targetType: null as unknown as string,
        targetId: null as unknown as string,
        requestId: null,
        details: {},
      } as unknown as import("@/lib/db/types").AuditLogRecord,
    ];
    (store as unknown as { auditLogs: unknown[] }).auditLogs.push(null as unknown as import("@/lib/db/types").AuditLogRecord);
    const res = await auditGet(req("/api/v1/admin/audit-logs?page=1&pageSize=10", { token: "uid:admin-1|admin@example.com" }));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.data.length).toBeGreaterThanOrEqual(2);
    // Missing at must be null, not now — we no longer mislead with current time
    const bad = body.data.find((l: { id: string }) => l.id === "log_bad");
    expect(bad.at).toBeNull();
    expect(body.error).toBeUndefined();
  });

  it("jobs/cleanup endpoint tolerates missing timestamps and null entries", async () => {
    store.cleanupRuns.set("run_corrupt2", {
      id: "run_corrupt2",
      startedAt: null as unknown as number,
      finishedAt: "bad-date" as unknown as number,
      status: null as unknown as string,
      scanned: null as unknown as number,
      deleted: undefined as unknown as number,
      reservationReleased: undefined as unknown as number,
      notified: undefined as unknown as number,
      failed: undefined as unknown as number,
      errors: undefined as unknown as Array<{ message: string }>,
      triggeredBy: null as unknown as string,
    } as unknown as import("@/lib/db/types").CleanupRunRecord);
    const res = await jobsGet(req("/api/v1/admin/jobs/cleanup", { token: "uid:admin-1|admin@example.com" }));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.data.runs.length).toBeGreaterThanOrEqual(1);
    const corrupt = body.data.runs.find((r: { id: string }) => r.id === "run_corrupt2");
    expect(corrupt.startedAt).toBeNull();
    expect(corrupt.finishedAt).toBeNull();
    expect(body.error).toBeUndefined();
  });

  it("drive-accounts list tolerates missing timestamps and null records", async () => {
    (store as unknown as { driveAccounts: Map<string, unknown> }).driveAccounts.set("drv_null", null as unknown as import("@/lib/db/types").DriveAccountRecord);
    (store as unknown as { driveAccounts: Map<string, unknown> }).driveAccounts.set("drv_bad2", {
      id: "drv_bad2",
      accountEmail: null,
      displayName: null,
      status: null as unknown as string,
      verified: null as unknown as boolean,
      connectedAt: "invalid" as unknown as number,
      updatedAt: undefined as unknown as number,
      lastSuccessAt: "not-a-date" as unknown as number,
      lastErrorAt: null,
      lastErrorMessage: null,
      fileCount: null as unknown as number,
      totalBytes: undefined as unknown as number,
      quotaInfo: null,
      managedFolderId: null,
      disabledReason: null,
    });
    const res = await driveListGet(req("/api/v1/admin/drive-accounts", { token: "uid:admin-1|admin@example.com" }));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(Array.isArray(body.data)).toBe(true);
    const bad = body.data.find((a: { id: string }) => a.id === "drv_bad2");
    expect(bad).toBeDefined();
    expect(bad.connectedAt).toBeNull(); // not misleading now
    expect(body.data.find((a: { id: string }) => a.id === "drv_null")).toBeUndefined();
  });

  it("duplicate endpoint reports groups safely with corrupted records", async () => {
    const a1 = await store.createDriveAccount({ accountEmail: "dup@example.com", displayName: null, scope: "x", googleAccountId: "sub_123" });
    const a2 = await store.createDriveAccount({ accountEmail: "dup@example.com", displayName: null, scope: "x", googleAccountId: "sub_123" });
    (store.driveAccounts.get(a1.id)! as unknown as Record<string, unknown>).connectedAt = undefined;
    const res = await dupGet(req("/api/v1/admin/drive-accounts/duplicates", { token: "uid:admin-1|admin@example.com" }));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.data.groups.length).toBeGreaterThanOrEqual(1);
    expect(body.data.groups[0].accounts.length).toBe(2);
    expect(body.data.groups[0].accounts.find((a: { id: string }) => a.id === a1.id).connectedAt).toBeNull();
  });
});

describe("drive disconnect resilience — token, account, audit failure paths", () => {
  it("disconnect succeeds when token does not exist (idempotent, no false success)", async () => {
    const acc = await store.createDriveAccount({ accountEmail: "nobody@example.com", displayName: "No Token", scope: "x" });
    // No token saved — delete should be no-op
    expect(await store.getDriveToken(acc.id)).toBeNull();
    const res = await driveDelete(
      req(`/api/v1/admin/drive-accounts/${acc.id}?confirm=DISCONNECT`, { method: "DELETE", token: "uid:admin-1|admin@example.com" }),
      { params: { id: acc.id } }
    );
    expect(res.status).toBe(200);
    expect((await store.getDriveAccount(acc.id))?.status).toBe("disconnected");
  });

  it("token deletion failure must NOT mark account disconnected (accurate state)", async () => {
    const acc = await store.createDriveAccount({ accountEmail: "fail-token@example.com", displayName: "Fail", scope: "x" });
    await store.saveDriveToken({ accountId: acc.id, refreshToken: "rt", scope: "x", obtainedAt: Date.now() });
    const originalDelete = store.deleteDriveToken.bind(store);
    store.deleteDriveToken = async () => {
      throw new Error("simulated RTDB permission denied");
    };
    const res = await driveDelete(
      req(`/api/v1/admin/drive-accounts/${acc.id}?confirm=DISCONNECT`, { method: "DELETE", token: "uid:admin-1|admin@example.com" }),
      { params: { id: acc.id } }
    );
    expect(res.status).toBe(500);
    const body = await json(res);
    expect(body.error.code).toBe("INTERNAL");
    expect(body.error.message).toContain("Could not destroy stored credentials");
    // Account must remain in original state — never falsely show disconnected
    expect((await store.getDriveAccount(acc.id))?.status).toBe("enabled");
    expect(await store.getDriveToken(acc.id)).not.toBeNull();
    store.deleteDriveToken = originalDelete;
  });

  it("token still present after delete triggers error (no false success)", async () => {
    const acc = await store.createDriveAccount({ accountEmail: "still-there@example.com", displayName: "Still", scope: "x" });
    await store.saveDriveToken({ accountId: acc.id, refreshToken: "rt", scope: "x", obtainedAt: Date.now() });
    // Mock delete to be no-op (token not actually removed)
    const realGet = store.getDriveToken.bind(store);
    store.deleteDriveToken = async () => { /* no-op */ };
    const res = await driveDelete(
      req(`/api/v1/admin/drive-accounts/${acc.id}?confirm=DISCONNECT`, { method: "DELETE", token: "uid:admin-1|admin@example.com" }),
      { params: { id: acc.id } }
    );
    expect(res.status).toBe(500);
    expect((await json(res)).error.message).toContain("still present");
    expect((await store.getDriveAccount(acc.id))?.status).toBe("enabled");
    store.deleteDriveToken = async (id: string) => {
      // restore real delete
      const s = store as unknown as { driveTokens: Map<string, unknown> };
      s.driveTokens.delete(id);
    };
    store.getDriveToken = realGet;
  });

  it("account update failure reports internal error and does not show disconnected", async () => {
    const acc = await store.createDriveAccount({ accountEmail: "update-fail@example.com", displayName: "UF", scope: "x" });
    store.updateDriveAccount = async () => null; // simulate transaction abort
    const res = await driveDelete(
      req(`/api/v1/admin/drive-accounts/${acc.id}?confirm=DISCONNECT`, { method: "DELETE", token: "uid:admin-1|admin@example.com" }),
      { params: { id: acc.id } }
    );
    expect(res.status).toBe(500);
    expect((await json(res)).error.message).toContain("Could not update drive account status");
  });

  it("audit failure does NOT roll back disconnect (secondary effect) and is observable via logs", async () => {
    const acc = await store.createDriveAccount({ accountEmail: "support.amisayem@gmail.com", displayName: "Support", scope: "x" });
    const original = store.appendAudit.bind(store);
    let callCount = 0;
    store.appendAudit = async (log) => {
      callCount += 1;
      if (callCount === 1) throw new Error("simulated audit failure");
      return original(log);
    };
    const res = await driveDelete(
      req(`/api/v1/admin/drive-accounts/${acc.id}?confirm=DISCONNECT`, { method: "DELETE", token: "uid:admin-1|admin@example.com" }),
      { params: { id: acc.id } }
    );
    expect(res.status).toBe(200);
    expect((await store.getDriveAccount(acc.id))?.status).toBe("disconnected");
    expect(await store.getDriveToken(acc.id)).toBeNull();
    expect(callCount).toBe(1);
    // Retry is idempotent — second call can succeed and log audit
    store.appendAudit = original;
    const retry = await driveDelete(
      req(`/api/v1/admin/drive-accounts/${acc.id}?confirm=DISCONNECT`, { method: "DELETE", token: "uid:admin-1|admin@example.com" }),
      { params: { id: acc.id } }
    );
    expect(retry.status).toBe(200); // already disconnected, still 200 (idempotent)
  });

  it("production duplicate case: both enabled 0 files, primary is most recently updated", async () => {
    // Simulate exact production ids (no DB write for them — just test selection logic)
    // Create two accounts with same normalized email, different updatedAt
    const primary = await store.createDriveAccount({ accountEmail: "support.amisayem@gmail.com", displayName: "Primary", scope: "x", googleAccountId: "sub_prod_123" });
    await new Promise((r) => setTimeout(r, 10));
    const secondary = await store.createDriveAccount({ accountEmail: "support.amisayem@gmail.com", displayName: "Secondary", scope: "x", googleAccountId: "sub_prod_123" });
    // Force primary to be newer (as production would have one newer)
    const pRec = store.driveAccounts.get(primary.id)!;
    const sRec = store.driveAccounts.get(secondary.id)!;
    pRec.updatedAt = Date.now();
    sRec.updatedAt = Date.now() - 100000;
    pRec.fileCount = 0; sRec.fileCount = 0;
    pRec.status = "enabled"; sRec.status = "enabled";
    const accounts = await store.listDriveAccounts();
    const groups = findDuplicateGroups(accounts);
    expect(groups.length).toBe(1);
    expect(groups[0].accountIds).toContain(primary.id);
    expect(groups[0].accountIds).toContain(secondary.id);
    expect(groups[0].kind).toBe("googleAccountId");
    // Simulate production naming: drv_EXPCVT1d3wiA vs drv_tn_0smO6B9Qt
    // The newer updatedAt is primary — secondary should be the one to disconnect manually
    const cands = accounts.filter((a) => a.googleAccountId === "sub_prod_123");
    const sorted = [...cands].sort((a, b) => {
      const aSub = a.googleAccountId === "sub_prod_123" ? 1 : 0;
      const bSub = b.googleAccountId === "sub_prod_123" ? 1 : 0;
      if (aSub !== bSub) return bSub - aSub;
      const aCred = a.status !== "disconnected" ? 1 : 0;
      const bCred = b.status !== "disconnected" ? 1 : 0;
      if (aCred !== bCred) return bCred - aCred;
      return b.updatedAt - a.updatedAt;
    });
    expect(sorted[0].id).toBe(primary.id);
    expect(sorted[1].id).toBe(secondary.id);
    // No deletion occurred — both still exist (strict permission)
    expect(await store.getDriveAccount(primary.id)).toBeDefined();
    expect(await store.getDriveAccount(secondary.id)).toBeDefined();
  });

  it("drive disconnect works for either duplicate without deleting the other", async () => {
    const a1 = await store.createDriveAccount({ accountEmail: "support.amisayem@gmail.com", displayName: "A", scope: "x" });
    const a2 = await store.createDriveAccount({ accountEmail: "support.amisayem@gmail.com", displayName: "B", scope: "x" });
    await store.saveDriveToken({ accountId: a1.id, refreshToken: "rt1", scope: "x", obtainedAt: Date.now() });
    const res = await driveDelete(
      req(`/api/v1/admin/drive-accounts/${a1.id}?confirm=DISCONNECT`, { method: "DELETE", token: "uid:admin-1|admin@example.com" }),
      { params: { id: a1.id } }
    );
    expect(res.status).toBe(200);
    expect((await store.getDriveAccount(a2.id))?.status).toBe("enabled");
    expect((await store.getDriveAccount(a1.id))?.status).toBe("disconnected");
    expect(await store.getDriveToken(a1.id)).toBeNull();
  });

  it("disconnect is idempotent: second call on already disconnected still succeeds", async () => {
    const acc = await store.createDriveAccount({ accountEmail: "idem@example.com", displayName: "Idem", scope: "x" });
    await store.saveDriveToken({ accountId: acc.id, refreshToken: "rt", scope: "x", obtainedAt: Date.now() });
    const first = await driveDelete(
      req(`/api/v1/admin/drive-accounts/${acc.id}?confirm=DISCONNECT`, { method: "DELETE", token: "uid:admin-1|admin@example.com" }),
      { params: { id: acc.id } }
    );
    expect(first.status).toBe(200);
    const second = await driveDelete(
      req(`/api/v1/admin/drive-accounts/${acc.id}?confirm=DISCONNECT`, { method: "DELETE", token: "uid:admin-1|admin@example.com" }),
      { params: { id: acc.id } }
    );
    expect(second.status).toBe(200);
    expect((await store.getDriveAccount(acc.id))?.status).toBe("disconnected");
  });
});
