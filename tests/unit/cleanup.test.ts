import { describe, expect, it } from "vitest";
import { MemoryStore } from "@/lib/db/memory-store";
import { deleteFileFully, runCleanup } from "@/lib/services/cleanup";
import { FakeDriveProvider } from "./fake-drive-provider";
import type { AppConfig } from "@/lib/config";

const GB = 1024 * 1024 * 1024;

function testConfig(over: Partial<AppConfig> = {}): AppConfig {
  return {
    appBaseUrl: "https://swkf.vercel.app",
    corsOrigins: [],
    firebaseWeb: {
      apiKey: "",
      authDomain: "",
      databaseURL: "",
      projectId: "kotha-bolbo-aso",
      storageBucket: "",
      messagingSenderId: "",
      appId: "",
    },
    adminClientEmail: "x@y.z",
    adminPrivateKey: "k",
    projectId: "kotha-bolbo-aso",
    databaseUrl: "https://example.firebaseio.com",
    apiSecretKey: "s".repeat(40),
    googleOAuthClientId: "id",
    googleOAuthClientSecret: "secret",
    googleOAuthScopes: [],
    defaultUserQuotaBytes: 2 * GB,
    maxUploadBytes: 512 * 1024 * 1024,
    fileTtlDays: 60,
    notifyExpiryDays: [7, 3],
    uploadTicketTtlMinutes: 60,
    adminEmails: [],
    appVersionDefault: "1.0.0",
    ...over,
  };
}

async function seedConfirmedFile(
  store: MemoryStore,
  provider: FakeDriveProvider,
  opts: { uid?: string; expiresAt?: number; name?: string; sizeBytes?: number } = {}
) {
  const uid = opts.uid ?? "user-1";
  const acct = await store.createDriveAccount({ accountEmail: "s@example.com", displayName: null, scope: "x" });
  await store.updateDriveAccount(acct.id, { managedFolderId: provider.managedFolderId });
  await store.saveDriveToken({ accountId: acct.id, refreshToken: "rt", scope: "x", obtainedAt: Date.now() });
  const { session } = await store.createUploadSession({
    uid,
    category: "photo",
    name: opts.name ?? "pic.png",
    mimeType: "image/png",
    expectedBytes: opts.sizeBytes ?? 100,
    idempotencyKey: `key-${Math.random().toString(36).slice(2, 12)}`,
    ticketTtlMs: 60_000,
    defaultQuotaBytes: 2 * GB,
  });
  await store.assignUploadProvider(session.id, { providerAccountId: acct.id, providerSessionUrl: "https://fake" });
  const providerFileId = provider.completeUpload("https://fake", {
    name: opts.name ?? "pic.png",
    mimeType: "image/png",
    sizeBytes: opts.sizeBytes ?? 100,
    parentId: provider.managedFolderId,
  });
  const { file } = await store.confirmUpload({
    uploadId: session.id,
    uid,
    providerFileId,
    verifiedName: opts.name ?? "pic.png",
    verifiedMimeType: "image/png",
    verifiedSizeBytes: opts.sizeBytes ?? 100,
    verifiedParents: [provider.managedFolderId],
    managedFolderId: provider.managedFolderId,
    verifiedCreatedTime: Date.now(),
    ttlDays: 60,
  });
  if (opts.expiresAt !== undefined) {
    await store.updateFileRecord(file.id, {}); // touch
    (store.files.get(file.id) as { expiresAt: number }).expiresAt = opts.expiresAt;
  }
  return { file, accountId: acct.id, providerFileId };
}

describe("file deletion", () => {
  it("deletes the exact provider object and updates quota", async () => {
    const store = new MemoryStore();
    const provider = new FakeDriveProvider();
    const { file, providerFileId } = await seedConfirmedFile(store, provider);
    const res = await deleteFileFully(store, testConfig(), file, {
      actor: "test",
      providerFactory: async () => provider,
    });
    expect(res.ok).toBe(true);
    expect(provider.deletedIds).toContain(providerFileId);
    const snap = await store.getQuotaSnapshot("user-1");
    expect(snap!.usedBytes).toBe(0);
    expect(snap!.fileCount).toBe(0);
  });

  it("treats a missing provider object as already deleted (idempotent)", async () => {
    const store = new MemoryStore();
    const provider = new FakeDriveProvider();
    const { file, providerFileId } = await seedConfirmedFile(store, provider);
    provider.objects.delete(providerFileId);
    const res = await deleteFileFully(store, testConfig(), file, {
      actor: "test",
      providerFactory: async () => provider,
    });
    expect(res.ok).toBe(true);
    expect(res.alreadyGone).toBe(true);
  });

  it("refuses to delete objects outside the managed folder", async () => {
    const store = new MemoryStore();
    const provider = new FakeDriveProvider();
    const { file, providerFileId } = await seedConfirmedFile(store, provider);
    // Move the object to a "personal" folder — a real user's Drive content.
    const obj = provider.objects.get(providerFileId)!;
    obj.parents = ["personal-folder"];
    const res = await deleteFileFully(store, testConfig(), file, {
      actor: "test",
      providerFactory: async () => provider,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/managed app folder/);
    expect(provider.deletedIds).not.toContain(providerFileId);
  });

  it("retries transient provider failures with backoff, then marks permanent failure", async () => {
    const store = new MemoryStore();
    const provider = new FakeDriveProvider();
    const { file, providerFileId } = await seedConfirmedFile(store, provider);
    provider.failDelete.set(providerFileId, new Error("503 service unavailable"));
    const res = await deleteFileFully(store, testConfig(), file, {
      actor: "test",
      providerFactory: async () => provider,
    });
    expect(res.ok).toBe(false);
    const updated = await store.getFile(file.id);
    expect(updated!.status).toBe("pending_delete");
    expect(updated!.deleteAttempts).toBe(1);
    const retry = await store.getRetryEntry(file.id);
    expect(retry).not.toBeNull();
    expect(retry!.attempts).toBe(1);

    // Next attempt succeeds and clears the retry entry.
    provider.failDelete.delete(providerFileId);
    const res2 = await deleteFileFully(store, testConfig(), updated!, {
      actor: "test",
      providerFactory: async () => provider,
    });
    expect(res2.ok).toBe(true);
    expect(await store.getRetryEntry(file.id)).toBeNull();
  });
});

describe("cleanup job", () => {
  it("deletes expired files and releases stale reservations", async () => {
    const store = new MemoryStore();
    const provider = new FakeDriveProvider();
    const { file } = await seedConfirmedFile(store, provider, { expiresAt: Date.now() - 1000 });
    // Stale ticket
    await store.createUploadSession({
      uid: "user-2",
      category: "chat",
      name: "note.txt",
      mimeType: "text/plain",
      expectedBytes: 50,
      idempotencyKey: "key-stale-ticket",
      ticketTtlMs: 1,
      defaultQuotaBytes: 2 * GB,
    });
    await new Promise((r) => setTimeout(r, 5));

    const { run } = await runCleanup(store, testConfig(), {
      triggeredBy: "test",
      providerFactory: async () => provider,
    });
    expect(run.status).toBe("success");
    expect(run.deleted).toBe(1);
    expect(run.reservationReleased).toBe(1);
    expect(provider.deletedIds).toContain(file.providerFileId);
    expect((await store.getFile(file.id))!.status).toBe("deleted");
    const snap = await store.getQuotaSnapshot("user-1");
    expect(snap!.usedBytes).toBe(0);
    const snap2 = await store.getQuotaSnapshot("user-2");
    expect(snap2!.reservedBytes).toBe(0);
  });

  it("is idempotent across repeated runs", async () => {
    const store = new MemoryStore();
    const provider = new FakeDriveProvider();
    await seedConfirmedFile(store, provider, { expiresAt: Date.now() - 1000 });
    const cfg = testConfig();
    const first = await runCleanup(store, cfg, { triggeredBy: "test", providerFactory: async () => provider });
    const second = await runCleanup(store, cfg, { triggeredBy: "test", providerFactory: async () => provider });
    expect(first.run.deleted).toBe(1);
    expect(second.run.deleted).toBe(0);
    expect(second.run.failed).toBe(0);
  });

  it("skips notifications when no device tokens exist (never fakes them)", async () => {
    const store = new MemoryStore();
    const provider = new FakeDriveProvider();
    // File expiring in exactly 7 days window (6.5 days out).
    await seedConfirmedFile(store, provider, { expiresAt: Date.now() + 6.5 * 86_400_000 });
    const { run } = await runCleanup(store, testConfig({ notifyExpiryDays: [7] }), {
      triggeredBy: "test",
      providerFactory: async () => provider,
    });
    expect(run.notified).toBe(0);
  });

  it("removes orphaned provider objects for abandoned uploads", async () => {
    const store = new MemoryStore();
    const provider = new FakeDriveProvider();
    const acct = await store.createDriveAccount({ accountEmail: "s@example.com", displayName: null, scope: "x" });
    await store.updateDriveAccount(acct.id, { managedFolderId: provider.managedFolderId });
    await store.saveDriveToken({ accountId: acct.id, refreshToken: "rt", scope: "x", obtainedAt: Date.now() });
    const { session } = await store.createUploadSession({
      uid: "user-1",
      category: "other",
      name: "orphan.bin",
      mimeType: "application/octet-stream",
      expectedBytes: 10,
      idempotencyKey: "key-orphan-upload",
      ticketTtlMs: 1,
      defaultQuotaBytes: 2 * GB,
    });
    await store.assignUploadProvider(session.id, { providerAccountId: acct.id, providerSessionUrl: "https://fake" });
    const orphanId = provider.completeUpload("https://fake", {
      name: "orphan.bin",
      mimeType: "application/octet-stream",
      sizeBytes: 10,
      parentId: provider.managedFolderId,
    });
    await store.markUploadUploaded(session.id, orphanId);
    await new Promise((r) => setTimeout(r, 5));

    await runCleanup(store, testConfig(), { triggeredBy: "test", providerFactory: async () => provider });
    expect(provider.deletedIds).toContain(orphanId);
    expect((await store.getQuotaSnapshot("user-1"))!.reservedBytes).toBe(0);
  });
});
