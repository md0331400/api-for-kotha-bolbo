import { describe, expect, it } from "vitest";
import { MemoryStore } from "@/lib/db/memory-store";
import { ApiError } from "@/lib/errors";

const GB = 1024 * 1024 * 1024;

function baseInput(over: Partial<Parameters<MemoryStore["createUploadSession"]>[0]> = {}) {
  return {
    uid: "user-1",
    category: "photo" as const,
    name: "cat.png",
    mimeType: "image/png",
    expectedBytes: 1000,
    idempotencyKey: "key-12345678",
    ticketTtlMs: 60_000,
    defaultQuotaBytes: 2 * GB,
    ...over,
  };
}

async function confirmFixture(store: MemoryStore, uploadId: string, sizeBytes = 1000, providerFileId = "prov-1") {
  const session = await store.getUploadSession(uploadId);
  return store.confirmUpload({
    uploadId,
    uid: "user-1",
    providerFileId,
    verifiedName: session?.name ?? "cat.png",
    verifiedMimeType: session?.mimeType ?? "image/png",
    verifiedSizeBytes: sizeBytes,
    verifiedParents: ["folder-1"],
    managedFolderId: "folder-1",
    verifiedCreatedTime: Date.now(),
    ttlDays: 60,
  });
}

describe("quota reservations", () => {
  it("reserves quota and tracks remaining", async () => {
    const store = new MemoryStore();
    await store.createUploadSession(baseInput({ expectedBytes: 500 }));
    const snap = await store.getQuotaSnapshot("user-1");
    expect(snap!.reservedBytes).toBe(500);
    expect(snap!.usedBytes).toBe(0);
    expect(snap!.remainingBytes).toBe(2 * GB - 500);
    expect(snap!.fileCount).toBe(0);
  });

  it("rejects uploads exceeding quota", async () => {
    const store = new MemoryStore();
    await store.createUploadSession(baseInput({ expectedBytes: 2 * GB, idempotencyKey: "key-aaaaaaaa" }));
    await expect(store.createUploadSession(baseInput({ expectedBytes: 1, idempotencyKey: "key-bbbbbbbb" }))).rejects.toMatchObject({
      code: "QUOTA_EXCEEDED",
    });
  });

  it("prevents concurrent reservations from exceeding quota", async () => {
    const store = new MemoryStore();
    // 1.5 GiB quota; three concurrent 600 MiB uploads — only two can reserve.
    await store.setUserFields((await store.upsertUserOnLogin({ uid: "user-1", email: null, displayName: null, photoURL: null })).uid, {
      quotaBytes: 1.5 * GB,
    });
    const attempts = await Promise.allSettled([
      store.createUploadSession(baseInput({ expectedBytes: 600 * 1024 * 1024, idempotencyKey: "key-11111111" })),
      store.createUploadSession(baseInput({ expectedBytes: 600 * 1024 * 1024, idempotencyKey: "key-22222222" })),
      store.createUploadSession(baseInput({ expectedBytes: 600 * 1024 * 1024, idempotencyKey: "key-33333333" })),
    ]);
    const ok = attempts.filter((a) => a.status === "fulfilled");
    const failed = attempts.filter((a) => a.status === "rejected");
    expect(ok.length).toBe(2);
    expect(failed.length).toBe(1);
    const snap = await store.getQuotaSnapshot("user-1");
    expect(snap!.reservedBytes).toBe(1200 * 1024 * 1024);
  });

  it("blocks restricted users", async () => {
    const store = new MemoryStore();
    await store.upsertUserOnLogin({ uid: "user-1", email: null, displayName: null, photoURL: null });
    await store.setUserFields("user-1", { restricted: true });
    await expect(store.createUploadSession(baseInput())).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("consumes reservation on confirm and applies verified size", async () => {
    const store = new MemoryStore();
    const { session } = await store.createUploadSession(baseInput());
    await confirmFixture(store, session.id, 800);
    const snap = await store.getQuotaSnapshot("user-1");
    expect(snap!.usedBytes).toBe(800);
    expect(snap!.reservedBytes).toBe(0);
    expect(snap!.remainingBytes).toBe(2 * GB - 800);
    expect(snap!.fileCount).toBe(1);
  });
});

describe("upload sessions and idempotency", () => {
  it("is idempotent for the same (uid, key)", async () => {
    const store = new MemoryStore();
    const first = await store.createUploadSession(baseInput());
    const second = await store.createUploadSession(baseInput());
    expect(second.reused).toBe(true);
    expect(second.session.id).toBe(first.session.id);
    const snap = await store.getQuotaSnapshot("user-1");
    expect(snap!.reservedBytes).toBe(1000); // reserved once
  });

  it("confirm is idempotent and returns the same file", async () => {
    const store = new MemoryStore();
    const { session } = await store.createUploadSession(baseInput());
    const first = await confirmFixture(store, session.id);
    const second = await confirmFixture(store, session.id);
    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.file.id).toBe(first.file.id);
    const snap = await store.getQuotaSnapshot("user-1");
    expect(snap!.usedBytes).toBe(1000);
    expect(snap!.reservedBytes).toBe(0);
    expect(snap!.fileCount).toBe(1);
  });

  it("rejects confirming another user's session", async () => {
    const store = new MemoryStore();
    const { session } = await store.createUploadSession(baseInput());
    await expect(
      store.confirmUpload({
        uploadId: session.id,
        uid: "attacker",
        providerFileId: "prov-x",
        verifiedName: "x",
        verifiedMimeType: "image/png",
        verifiedSizeBytes: 10,
        verifiedParents: [],
        managedFolderId: "folder-1",
        verifiedCreatedTime: Date.now(),
        ttlDays: 60,
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects oversized provider objects and releases the reservation", async () => {
    const store = new MemoryStore();
    const { session } = await store.createUploadSession(baseInput());
    await expect(confirmFixture(store, session.id, 2000)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const snap = await store.getQuotaSnapshot("user-1");
    expect(snap!.reservedBytes).toBe(0);
  });

  it("claims each provider object exactly once", async () => {
    const store = new MemoryStore();
    await store.createDriveAccount({ accountEmail: "a@b.c", displayName: null, scope: "s" });
    const a1 = await store.createUploadSession(baseInput({ idempotencyKey: "key-11111111" }));
    const a2 = await store.createUploadSession(baseInput({ idempotencyKey: "key-22222222" }));
    await store.assignUploadProvider(a1.session.id, { providerAccountId: "drv_x", providerSessionUrl: "u1" });
    await store.assignUploadProvider(a2.session.id, { providerAccountId: "drv_x", providerSessionUrl: "u2" });
    const ok = await confirmFixture(store, a1.session.id, 1000, "prov-shared");
    expect(ok.reused).toBe(false);
    await expect(confirmFixture(store, a2.session.id, 1000, "prov-shared")).rejects.toMatchObject({
      code: "DUPLICATE",
    });
  });

  it("release is idempotent and frees quota once", async () => {
    const store = new MemoryStore();
    const { session } = await store.createUploadSession(baseInput());
    const r1 = await store.releaseUploadReservation(session.id, "FAILURE");
    const r2 = await store.releaseUploadReservation(session.id, "FAILURE");
    expect(r1.released).toBe(true);
    expect(r2.released).toBe(false);
    const snap = await store.getQuotaSnapshot("user-1");
    expect(snap!.reservedBytes).toBe(0);
  });

  it("releases stale tickets for cleanup", async () => {
    const store = new MemoryStore();
    const { session } = await store.createUploadSession(baseInput({ ticketTtlMs: 1 }));
    await new Promise((r) => setTimeout(r, 5));
    const stale = await store.listUploadsForCleanup(Date.now(), 10);
    expect(stale.map((s) => s.id)).toContain(session.id);
    await store.releaseUploadReservation(session.id, "TICKET_EXPIRED");
    const snap = await store.getQuotaSnapshot("user-1");
    expect(snap!.reservedBytes).toBe(0);
  });
});

describe("usage recomputation heals drift", () => {
  it("rebuilds counters from authoritative records", async () => {
    const store = new MemoryStore();
    const { session } = await store.createUploadSession(baseInput());
    await confirmFixture(store, session.id, 1000, "prov-recompute");
    // Simulate drift.
    const user = (await store.getUser("user-1"))!;
    user.usedBytes = 999999;
    user.fileCount = 42;
    user.reservedBytes = 777;
    const snap = await store.recomputeUserUsage("user-1");
    expect(snap.usedBytes).toBe(1000);
    expect(snap.fileCount).toBe(1);
    expect(snap.reservedBytes).toBe(0);
  });
});

describe("files and deletion", () => {
  it("decrements usage when a file is deleted", async () => {
    const store = new MemoryStore();
    const { session } = await store.createUploadSession(baseInput());
    const { file } = await confirmFixture(store, session.id);
    await store.updateFileRecord(file.id, { status: "deleted", deletedAt: Date.now() });
    const snap = await store.getQuotaSnapshot("user-1");
    expect(snap!.usedBytes).toBe(0);
    expect(snap!.fileCount).toBe(0);
  });

  it("filters and paginates file lists", async () => {
    const store = new MemoryStore();
    for (let i = 0; i < 5; i++) {
      const { session } = await store.createUploadSession(
        baseInput({ idempotencyKey: `key-0000000${i}`, category: i % 2 ? "video" : "photo", name: `f${i}.bin` })
      );
      await confirmFixture(store, session.id, 100, `prov-${i}`);
    }
    const page1 = await store.listFiles({}, { page: 1, pageSize: 2, offset: 0 });
    expect(page1.total).toBe(5);
    expect(page1.items).toHaveLength(2);
    const photos = await store.listFiles({ category: "photo" }, { page: 1, pageSize: 10, offset: 0 });
    expect(photos.total).toBe(3);
    const search = await store.listFiles({ q: "f3" }, { page: 1, pageSize: 10, offset: 0 });
    expect(search.total).toBe(1);
  });

  it("lists files expiring within a window", async () => {
    const store = new MemoryStore();
    const { session } = await store.createUploadSession(baseInput());
    await confirmFixture(store, session.id);
    const soon = await store.listExpiringBetween(Date.now(), Date.now() + 61 * 86_400_000, 10);
    expect(soon).toHaveLength(1);
  });
});

describe("admins, audit, rate limits", () => {
  it("grants and revokes admin", async () => {
    const store = new MemoryStore();
    expect(await store.isAdmin("u1")).toBe(false);
    await store.grantAdmin("u1", "a@b.c", "test");
    expect(await store.isAdmin("u1")).toBe(true);
    await store.revokeAdmin("u1");
    expect(await store.isAdmin("u1")).toBe(false);
  });

  it("records audit logs with filters", async () => {
    const store = new MemoryStore();
    await store.appendAudit({
      actorUid: "u1",
      actorEmail: "a@b.c",
      action: "user.quota.change",
      targetType: "user",
      targetId: "u2",
      requestId: "r1",
      details: { quotaBytes: 5 },
    });
    const all = await store.listAuditLogs({}, { page: 1, pageSize: 10, offset: 0 });
    expect(all.total).toBe(1);
    const filtered = await store.listAuditLogs({ action: "quota" }, { page: 1, pageSize: 10, offset: 0 });
    expect(filtered.total).toBe(1);
  });

  it("enforces rate limits per key and window", async () => {
    const store = new MemoryStore();
    for (let i = 0; i < 3; i++) {
      const hit = await store.rateLimitHit("k", 3, 60);
      expect(hit.allowed).toBe(true);
    }
    const blocked = await store.rateLimitHit("k", 3, 60);
    expect(blocked.allowed).toBe(false);
    const other = await store.rateLimitHit("other", 3, 60);
    expect(other.allowed).toBe(true);
  });
});

describe("ApiError shape", () => {
  it("maps codes to HTTP statuses", () => {
    expect(new ApiError("QUOTA_EXCEEDED", "x").status).toBe(413);
    expect(new ApiError("UNAUTHENTICATED", "x").status).toBe(401);
    expect(new ApiError("FORBIDDEN", "x").status).toBe(403);
    expect(new ApiError("RATE_LIMITED", "x").status).toBe(429);
  });
});
