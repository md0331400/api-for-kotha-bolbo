import { createHash, randomBytes } from "node:crypto";
import type { Database, Reference } from "firebase-admin/database";
import { requireAdminSdk } from "@/lib/firebase-admin";
import { ApiError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import type {
  ApiKeyRecord,
  AppVersionRecord,
  AuditLogRecord,
  CleanupRetryRecord,
  CleanupRunRecord,
  DriveAccountRecord,
  DriveTokenRecord,
  FileRecord,
  NotificationSentRecord,
  NotificationTokenRecord,
  UploadSession,
  UserRecord,
} from "@/lib/db/types";
import type {
  ConfirmUploadInput,
  CreateUploadInput,
  FileFilters,
  ListResult,
  PageQuery,
  QuotaSnapshot,
  Store,
} from "@/lib/db/store";

/**
 * Production Store implementation backed by the Firebase Realtime Database
 * (persistent across serverless invocations, server-only via the Admin SDK).
 *
 * Concurrency safety:
 *  - Quota reservations use Realtime Database transactions on users/{uid}.
 *  - Provider objects are claimed with a transaction (single-claim).
 *  - Record writes that touch several nodes use one multi-path update (atomic).
 *  - User counters are maintained incrementally and are *derived state*:
 *    `recomputeUserUsage()` rebuilds them from authoritative records and is run
 *    by the cleanup job for every user touched in the run, healing crash-window
 *    drift.
 */

const SCHEMA_VERSION = 1;

function idemHash(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 32);
}

function safeKey(s: string): string {
  return s.replace(/[.#$/[\]]/g, "_");
}

function newRecordId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString("base64url")}`;
}

function matchQ(haystacks: Array<string | null | undefined>, q: string): boolean {
  const needle = q.toLowerCase();
  return haystacks.some((h) => (h ?? "").toLowerCase().includes(needle));
}

type TxOutcome = { committed: boolean; typedError?: ApiError };

export class RtdbStore implements Store {
  private db(): Database {
    return requireAdminSdk().db;
  }

  private ref(path: string): Reference {
    return this.db().ref(path);
  }

  private async val<T>(path: string): Promise<T | null> {
    const snap = await this.ref(path).once("value");
    const v = snap.val();
    return v === null || v === undefined ? null : (v as T);
  }

  private async set(path: string, value: unknown): Promise<void> {
    await this.ref(path).set(value);
  }

  private async update(path: string, values: Record<string, unknown>): Promise<void> {
    await this.ref(path).update(values);
  }

  /**
   * Transaction with typed abort errors. The updater returns `undefined` to
   * abort and may set `outcome.typedError`.
   */
  private async tx<T>(
    path: string,
    updater: (current: T | null, outcome: TxOutcome) => T | undefined
  ): Promise<{ committed: boolean; value: T | null; typedError?: ApiError }> {
    const outcome: TxOutcome = { committed: false };
    let final: T | null = null;
    const result = await this.ref(path).transaction((current) => {
      const next = updater((current ?? null) as T | null, outcome);
      if (next === undefined) {
        outcome.typedError = outcome.typedError ?? new ApiError("CONFLICT", "Transaction aborted.");
        return undefined;
      }
      outcome.committed = true;
      final = next;
      return next;
    }, undefined, false);
    return {
      committed: result.committed,
      value: (result.snapshot.val() ?? final ?? null) as T | null,
      typedError: outcome.typedError,
    };
  }

  async ensureSchema(): Promise<void> {
    const version = await this.val<number>("schemaVersion");
    if (version === SCHEMA_VERSION) return;
    await this.set("schemaVersion", SCHEMA_VERSION);
    logger.info("db.schema.ensure", { schemaVersion: SCHEMA_VERSION });
  }

  // ---- users -------------------------------------------------------------
  private defaultUser(
    uid: string,
    email: string | null,
    displayName: string | null,
    photoURL: string | null,
    quotaBytes: number
  ): UserRecord {
    const now = Date.now();
    return {
      uid,
      email,
      displayName,
      photoURL,
      quotaBytes,
      usedBytes: 0,
      reservedBytes: 0,
      fileCount: 0,
      restricted: false,
      createdAt: now,
      updatedAt: now,
      lastLoginAt: now,
    };
  }

  async getUser(uid: string): Promise<UserRecord | null> {
    return this.val<UserRecord>(`users/${safeKey(uid)}`);
  }

  async upsertUserOnLogin(p: {
    uid: string;
    email: string | null;
    displayName: string | null;
    photoURL: string | null;
  }): Promise<UserRecord> {
    const path = `users/${safeKey(p.uid)}`;
    const res = await this.tx<UserRecord>(path, (current) => {
      const now = Date.now();
      if (!current) return this.defaultUser(p.uid, p.email, p.displayName, p.photoURL, 2 * 1024 * 1024 * 1024);
      return {
        ...current,
        email: p.email ?? current.email,
        displayName: p.displayName ?? current.displayName,
        photoURL: p.photoURL ?? current.photoURL,
        lastLoginAt: now,
        updatedAt: now,
      };
    });
    const user = res.value!;
    if (user.email) {
      await this.set(`usersByEmail/${safeKey(user.email.toLowerCase())}`, safeKey(p.uid)).catch(() => undefined);
    }
    return user;
  }

  async listUsers(q: string | undefined, page: PageQuery): Promise<ListResult<UserRecord>> {
    const all = (await this.val<Record<string, UserRecord>>("users")) ?? {};
    let items = Object.values(all);
    if (q) items = items.filter((u) => matchQ([u.uid, u.email, u.displayName], q));
    items.sort((a, b) => b.createdAt - a.createdAt);
    const total = items.length;
    return { items: items.slice(page.offset, page.offset + page.pageSize), total };
  }

  async setUserFields(uid: string, patch: { quotaBytes?: number; restricted?: boolean }) {
    const path = `users/${safeKey(uid)}`;
    const res = await this.tx<UserRecord>(path, (current) => {
      if (!current) return undefined;
      return {
        ...current,
        quotaBytes: patch.quotaBytes ?? current.quotaBytes,
        restricted: patch.restricted ?? current.restricted,
        updatedAt: Date.now(),
      };
    });
    return res.committed ? res.value : this.getUser(uid);
  }

  async getQuotaSnapshot(uid: string): Promise<QuotaSnapshot | null> {
    const u = await this.getUser(uid);
    if (!u) return null;
    return {
      quotaBytes: u.quotaBytes,
      usedBytes: u.usedBytes,
      reservedBytes: u.reservedBytes,
      fileCount: u.fileCount,
      remainingBytes: Math.max(0, u.quotaBytes - u.usedBytes - u.reservedBytes),
      restricted: u.restricted,
    };
  }

  // ---- uploads / quota ---------------------------------------------------
  async createUploadSession(input: CreateUploadInput): Promise<{ session: UploadSession; reused: boolean }> {
    const now = Date.now();
    const hash = idemHash(input.idempotencyKey);
    const idemPath = `uploadsByIdem/${safeKey(input.uid)}/${hash}`;

    // 1. Idempotency CAS. Only the writer of a fresh pointer repairs staleness.
    let wroteFresh = false;
    const idemRes = await this.tx<string>(idemPath, (current) => {
      wroteFresh = !current;
      return current ?? newRecordId("up");
    });
    if (!idemRes.committed || !idemRes.value) {
      throw new ApiError("INTERNAL", "Could not create upload session.");
    }
    let uploadId = idemRes.value;

    const existing = await this.val<UploadSession>(`uploads/${safeKey(uploadId)}`);
    if (existing) {
      return { session: existing, reused: true };
    }
    if (wroteFresh) {
      // Fresh pointer with no session — nothing to repair, proceed.
    } else {
      // Stale pointer (session record lost): repair and allocate a fresh session.
      await this.set(idemPath, null).catch(() => undefined);
      uploadId = newRecordId("up");
      await this.set(idemPath, uploadId);
    }

    // 2. Session record first (flag false until reservation is counted).
    const fileId = newRecordId("file");
    const session: UploadSession = {
      id: uploadId,
      uid: input.uid,
      category: input.category,
      name: input.name,
      mimeType: input.mimeType,
      expectedBytes: input.expectedBytes,
      reservedBytes: input.expectedBytes,
      status: "reserved",
      idempotencyKey: input.idempotencyKey,
      providerAccountId: null,
      providerSessionUrl: null,
      providerFileId: null,
      fileId,
      createdAt: now,
      ticketExpiresAt: now + input.ticketTtlMs,
      updatedAt: now,
      reservationCounted: false,
    };
    await this.set(`uploads/${uploadId}`, session);

    // 3. Quota reservation transaction on the user record.
    const userPath = `users/${safeKey(input.uid)}`;
    const outcome: TxOutcome = { committed: false };
    const txRes = await this.tx<UserRecord>(userPath, (current, o) => {
      let user = current;
      if (!user) {
        user = this.defaultUser(input.uid, null, null, null, input.defaultQuotaBytes);
      }
      if (user.restricted) {
        o.typedError = new ApiError("FORBIDDEN", "Storage access is restricted for this account.");
        return undefined;
      }
      const remaining = user.quotaBytes - user.usedBytes - user.reservedBytes;
      if (input.expectedBytes > remaining) {
        o.typedError = new ApiError("QUOTA_EXCEEDED", "Insufficient storage quota for this upload.", {
          details: {
            quotaBytes: user.quotaBytes,
            usedBytes: user.usedBytes,
            reservedBytes: user.reservedBytes,
            requestedBytes: input.expectedBytes,
            remainingBytes: Math.max(0, remaining),
          },
        });
        return undefined;
      }
      return {
        ...user,
        reservedBytes: user.reservedBytes + input.expectedBytes,
        updatedAt: Date.now(),
      };
    });
    if (!txRes.committed) {
      await this.set(`uploads/${uploadId}/status`, "failed").catch(() => undefined);
      await this.set(`uploads/${uploadId}/error`, "RESERVATION_REJECTED").catch(() => undefined);
      await this.set(idemPath, null).catch(() => undefined);
      throw txRes.typedError ?? new ApiError("CONFLICT", "Could not reserve quota.");
    }

    // 4. Mark reservation as counted; compensate on failure.
    try {
      await this.set(`uploads/${uploadId}/reservationCounted`, true);
    } catch (e) {
      await this.tx<UserRecord>(userPath, (current) => {
        if (!current) return undefined;
        return {
          ...current,
          reservedBytes: Math.max(0, current.reservedBytes - input.expectedBytes),
          updatedAt: Date.now(),
        };
      });
      await this.set(idemPath, null).catch(() => undefined);
      logger.error("upload.reservation.flag_failed", { uploadId });
      throw new ApiError("INTERNAL", "Could not finalize quota reservation.", { cause: e });
    }

    const created = await this.val<UploadSession>(`uploads/${uploadId}`);
    return { session: created!, reused: false };
  }

  async getUploadSession(uploadId: string): Promise<UploadSession | null> {
    return this.val<UploadSession>(`uploads/${safeKey(uploadId)}`);
  }

  async assignUploadProvider(
    uploadId: string,
    input: { providerAccountId: string; providerSessionUrl: string }
  ): Promise<UploadSession | null> {
    const path = `uploads/${safeKey(uploadId)}`;
    const res = await this.tx<UploadSession>(path, (current) => {
      if (!current) return undefined;
      if (current.status !== "reserved" || current.providerAccountId) return current;
      return {
        ...current,
        providerAccountId: input.providerAccountId,
        providerSessionUrl: input.providerSessionUrl,
        updatedAt: Date.now(),
      };
    });
    return res.value;
  }

  async markUploadUploaded(uploadId: string, providerFileId: string): Promise<UploadSession | null> {
    const path = `uploads/${safeKey(uploadId)}`;
    const res = await this.tx<UploadSession>(path, (current) => {
      if (!current) return undefined;
      if (current.status !== "reserved") return current;
      return { ...current, status: "uploaded", providerFileId, updatedAt: Date.now() };
    });
    return res.value;
  }

  async confirmUpload(input: ConfirmUploadInput): Promise<{ file: FileRecord; reused: boolean }> {
    const sessionPath = `uploads/${safeKey(input.uploadId)}`;
    const s = await this.val<UploadSession>(sessionPath);
    if (!s) throw new ApiError("NOT_FOUND", "Upload session not found.");
    if (s.uid !== input.uid) throw new ApiError("FORBIDDEN", "Upload session belongs to another user.");

    if (s.status === "confirmed" && s.fileId) {
      const f = await this.getFile(s.fileId);
      if (f) return { file: f, reused: true };
    }
    if (s.status === "released" || s.status === "failed") {
      throw new ApiError("UPLOAD_NOT_CONFIRMED", "Upload session is no longer active.");
    }
    if (!s.providerAccountId) {
      throw new ApiError("UPLOAD_NOT_CONFIRMED", "Upload session has no provider assignment.");
    }

    const fileId = s.fileId!;
    // Single-claim of the provider object.
    const claimPath = `providerClaims/${safeKey(s.providerAccountId)}/${safeKey(input.providerFileId)}`;
    const claimRes = await this.tx<string>(claimPath, (current) => current ?? fileId);
    const claimed = claimRes.value;
    if (claimed !== fileId) {
      const claimedFile = await this.getFile(claimed!);
      if (claimedFile && claimedFile.uploadId !== s.id) {
        throw new ApiError("DUPLICATE", "This provider object is already registered.");
      }
    }

    if (input.verifiedSizeBytes > s.expectedBytes) {
      await this.releaseUploadReservation(input.uploadId, "SIZE_MISMATCH");
      throw new ApiError("BAD_REQUEST", "Uploaded object is larger than the reserved size.", {
        details: { expectedBytes: s.expectedBytes, actualBytes: input.verifiedSizeBytes },
      });
    }

    const now = Date.now();
    const file: FileRecord = {
      id: fileId,
      uid: s.uid,
      category: s.category,
      name: input.verifiedName || s.name,
      mimeType: input.verifiedMimeType || s.mimeType,
      sizeBytes: input.verifiedSizeBytes,
      createdAt: now,
      expiresAt: now + input.ttlDays * 86_400_000,
      providerAccountId: s.providerAccountId,
      providerFileId: input.providerFileId,
      status: "confirmed",
      uploadId: s.id,
    };

    // Atomic multi-path write: file record + per-user index + session finalize.
    await this.update("/", {
      [`files/${fileId}`]: file,
      [`filesByUid/${safeKey(s.uid)}/${fileId}`]: file,
      [sessionPath]: {
        ...s,
        status: "confirmed",
        fileId,
        providerFileId: input.providerFileId,
        reservationCounted: false,
        updatedAt: now,
      },
    });

    // Counters (derived; recompute heals any crash-window drift).
    await this.tx<UserRecord>(`users/${safeKey(s.uid)}`, (current) => {
      if (!current) return undefined;
      const release = s.reservationCounted !== false ? s.reservedBytes : 0;
      return {
        ...current,
        usedBytes: current.usedBytes + file.sizeBytes,
        reservedBytes: Math.max(0, current.reservedBytes - release),
        fileCount: current.fileCount + 1,
        updatedAt: now,
      };
    });

    await this.tx<DriveAccountRecord>(`driveAccounts/${safeKey(s.providerAccountId)}`, (current) => {
      if (!current) return undefined;
      return {
        ...current,
        fileCount: current.fileCount + 1,
        totalBytes: current.totalBytes + file.sizeBytes,
        lastSuccessAt: now,
        verified: true,
        updatedAt: now,
      };
    });

    return { file, reused: false };
  }

  async releaseUploadReservation(uploadId: string, reason: string): Promise<{ released: boolean }> {
    const sessionPath = `uploads/${safeKey(uploadId)}`;
    const s = await this.val<UploadSession>(sessionPath);
    if (!s) return { released: false };
    if (s.status === "confirmed" || s.status === "released") return { released: false };

    // Flag/status first (atomic), then decrement — a retried release is a no-op.
    await this.update(sessionPath, {
      status: "released",
      reservationCounted: false,
      error: reason,
      updatedAt: Date.now(),
    });
    if (s.reservationCounted !== false) {
      await this.tx<UserRecord>(`users/${safeKey(s.uid)}`, (current) => {
        if (!current) return undefined;
        return {
          ...current,
          reservedBytes: Math.max(0, current.reservedBytes - s.reservedBytes),
          updatedAt: Date.now(),
        };
      });
    }
    return { released: true };
  }

  async listUploadsForCleanup(now: number, limit: number): Promise<UploadSession[]> {
    const snap = await this.ref("uploads").orderByChild("ticketExpiresAt").endAt(now).limitToFirst(limit).once("value");
    const all = (snap.val() ?? {}) as Record<string, UploadSession>;
    return Object.values(all)
      .filter((s) => s.status === "reserved" || s.status === "uploaded")
      .sort((a, b) => a.ticketExpiresAt - b.ticketExpiresAt);
  }

  async listFailedUploads(limit: number): Promise<UploadSession[]> {
    const all = (await this.val<Record<string, UploadSession>>("uploads")) ?? {};
    return Object.values(all)
      .filter((s) => s.status === "failed" || s.status === "released")
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit);
  }

  async recomputeUserUsage(uid: string): Promise<QuotaSnapshot> {
    const userPath = `users/${safeKey(uid)}`;
    const user = await this.getUser(uid);
    if (!user) throw new ApiError("NOT_FOUND", "User not found.");
    const files = (await this.val<Record<string, FileRecord>>(`filesByUid/${safeKey(uid)}`)) ?? {};
    const uploads = (await this.val<Record<string, UploadSession>>("uploads")) ?? {};
    const now = Date.now();
    let used = 0;
    let count = 0;
    for (const f of Object.values(files)) {
      if (f.status === "confirmed") {
        used += f.sizeBytes;
        count += 1;
      }
    }
    let reserved = 0;
    for (const s of Object.values(uploads)) {
      if (
        s.uid === uid &&
        (s.status === "reserved" || s.status === "uploaded") &&
        s.ticketExpiresAt > now &&
        s.reservationCounted === true
      ) {
        reserved += s.reservedBytes;
      }
    }
    await this.tx<UserRecord>(userPath, (current) => {
      if (!current) return undefined;
      return { ...current, usedBytes: used, fileCount: count, reservedBytes: reserved, updatedAt: now };
    });
    return {
      quotaBytes: user.quotaBytes,
      usedBytes: used,
      reservedBytes: reserved,
      fileCount: count,
      remainingBytes: Math.max(0, user.quotaBytes - used - reserved),
      restricted: user.restricted,
    };
  }

  // ---- files -------------------------------------------------------------
  async getFile(fileId: string): Promise<FileRecord | null> {
    return this.val<FileRecord>(`files/${safeKey(fileId)}`);
  }

  async listFiles(filters: FileFilters, page: PageQuery): Promise<ListResult<FileRecord>> {
    const sourcePath = filters.uid ? `filesByUid/${safeKey(filters.uid)}` : "files";
    const all = (await this.val<Record<string, FileRecord>>(sourcePath)) ?? {};
    let items = Object.values(all);
    if (filters.uid) items = items.filter((f) => f.uid === filters.uid);
    if (filters.category) items = items.filter((f) => f.category === filters.category);
    if (filters.status) items = items.filter((f) => f.status === filters.status);
    if (filters.createdAfter !== undefined) items = items.filter((f) => f.createdAt >= filters.createdAfter!);
    if (filters.createdBefore !== undefined) items = items.filter((f) => f.createdAt <= filters.createdBefore!);
    if (filters.expiringInDays !== undefined) {
      const until = Date.now() + filters.expiringInDays * 86_400_000;
      items = items.filter((f) => f.expiresAt <= until && f.status !== "deleted");
    }
    const q = filters.q;
    if (q) items = items.filter((f) => matchQ([f.id, f.name, f.providerFileId], q));
    const sortKey = filters.sort ?? "createdAt";
    const dir = filters.order === "asc" ? 1 : -1;
    items.sort((a, b) => (a[sortKey] - b[sortKey]) * dir);
    const total = items.length;
    return { items: items.slice(page.offset, page.offset + page.pageSize), total };
  }

  async listExpiredFiles(now: number, limit: number): Promise<FileRecord[]> {
    const snap = await this.ref("files").orderByChild("expiresAt").endAt(now).limitToFirst(limit).once("value");
    const all = (snap.val() ?? {}) as Record<string, FileRecord>;
    return Object.values(all)
      .filter((f) => f.status === "confirmed")
      .sort((a, b) => a.expiresAt - b.expiresAt);
  }

  async listExpiringBetween(fromTs: number, toTs: number, limit: number): Promise<FileRecord[]> {
    const snap = await this.ref("files").orderByChild("expiresAt").startAt(fromTs).endAt(toTs).limitToFirst(limit).once("value");
    const all = (snap.val() ?? {}) as Record<string, FileRecord>;
    return Object.values(all)
      .filter((f) => f.status === "confirmed")
      .sort((a, b) => a.expiresAt - b.expiresAt);
  }

  async updateFileRecord(
    fileId: string,
    patch: Partial<Pick<FileRecord, "status" | "deletedAt" | "deleteAttempts" | "lastDeleteError" | "deletedBy">>
  ): Promise<FileRecord | null> {
    const path = `files/${safeKey(fileId)}`;
    let transitionedToDeleted = false;
    const res = await this.tx<FileRecord>(path, (current) => {
      if (!current) return undefined;
      const next: FileRecord = { ...current, ...patch };
      if (current.status !== "deleted" && next.status === "deleted") transitionedToDeleted = true;
      return next;
    });
    if (!res.committed) return null;
    const file = res.value!;
    await this.set(`filesByUid/${safeKey(file.uid)}/${fileId}`, file).catch(() => undefined);
    if (transitionedToDeleted) {
      await this.tx<UserRecord>(`users/${safeKey(file.uid)}`, (current) => {
        if (!current) return undefined;
        return {
          ...current,
          usedBytes: Math.max(0, current.usedBytes - file.sizeBytes),
          fileCount: Math.max(0, current.fileCount - 1),
          updatedAt: Date.now(),
        };
      });
      await this.tx<DriveAccountRecord>(`driveAccounts/${safeKey(file.providerAccountId)}`, (current) => {
        if (!current) return undefined;
        return {
          ...current,
          fileCount: Math.max(0, current.fileCount - 1),
          totalBytes: Math.max(0, current.totalBytes - file.sizeBytes),
          updatedAt: Date.now(),
        };
      });
    }
    return file;
  }

  async purgeUserFiles(uid: string, limit: number): Promise<number> {
    const files = (await this.val<Record<string, FileRecord>>(`filesByUid/${safeKey(uid)}`)) ?? {};
    let n = 0;
    const updates: Record<string, unknown> = {};
    for (const [id, f] of Object.entries(files)) {
      if (f.status === "confirmed" || f.status === "delete_failed") {
        updates[`files/${id}/status`] = "pending_delete";
        updates[`filesByUid/${safeKey(uid)}/${id}/status`] = "pending_delete";
        n += 1;
        if (n >= limit) break;
      }
    }
    if (n) await this.update("/", updates);
    return n;
  }

  // ---- drive -------------------------------------------------------------
  async listDriveAccounts(): Promise<DriveAccountRecord[]> {
    const all = (await this.val<Record<string, DriveAccountRecord>>("driveAccounts")) ?? {};
    return Object.values(all);
  }

  async getDriveAccount(id: string): Promise<DriveAccountRecord | null> {
    return this.val<DriveAccountRecord>(`driveAccounts/${safeKey(id)}`);
  }

  async createDriveAccount(input: {
    accountEmail: string | null;
    displayName: string | null;
    scope: string;
    id?: string;
    googleAccountId?: string | null;
  }): Promise<DriveAccountRecord> {
    const now = Date.now();
    const rec: DriveAccountRecord = {
      id: input.id ?? newRecordId("drv"),
      accountEmail: input.accountEmail,
      normalizedEmail: input.accountEmail ? input.accountEmail.trim().toLowerCase() : null,
      googleAccountId: input.googleAccountId ?? null,
      displayName: input.displayName,
      status: "enabled",
      verified: false,
      connectedAt: now,
      updatedAt: now,
      lastSuccessAt: null,
      lastErrorAt: null,
      lastErrorMessage: null,
      fileCount: 0,
      totalBytes: 0,
      quotaInfo: null,
      managedFolderId: null,
      disabledReason: null,
    };
    await this.set(`driveAccounts/${safeKey(rec.id)}`, rec);
    return rec;
  }

  async claimDriveIdentity(identityKey: string, accountId: string): Promise<string> {
    const path = `driveIdentities/${safeKey(identityKey)}`;
    const res = await this.tx<string>(path, (current) => current ?? accountId);
    return res.value ?? accountId;
  }

  async getDriveIdentityOwner(identityKey: string): Promise<string | null> {
    return this.val<string>(`driveIdentities/${safeKey(identityKey)}`);
  }

  async updateDriveAccount(
    id: string,
    patch: Partial<DriveAccountRecord>
  ): Promise<DriveAccountRecord | null> {
    const path = `driveAccounts/${safeKey(id)}`;
    const res = await this.tx<DriveAccountRecord>(path, (current) => {
      if (!current) return undefined;
      return { ...current, ...patch, updatedAt: Date.now() };
    });
    return res.committed ? res.value : this.getDriveAccount(id);
  }

  async saveDriveToken(t: DriveTokenRecord): Promise<void> {
    await this.set(`driveTokens/${safeKey(t.accountId)}`, t);
  }

  async getDriveToken(accountId: string): Promise<DriveTokenRecord | null> {
    return this.val<DriveTokenRecord>(`driveTokens/${safeKey(accountId)}`);
  }

  async deleteDriveToken(accountId: string): Promise<void> {
    await this.set(`driveTokens/${safeKey(accountId)}`, null);
  }

  async claimProviderFile(accountId: string, providerFileId: string, fileId: string): Promise<boolean> {
    const path = `providerClaims/${safeKey(accountId)}/${safeKey(providerFileId)}`;
    const res = await this.tx<string>(path, (current) => current ?? fileId);
    return res.value === fileId;
  }

  async getProviderClaim(accountId: string, providerFileId: string): Promise<string | null> {
    return this.val<string>(`providerClaims/${safeKey(accountId)}/${safeKey(providerFileId)}`);
  }

  async addAccountStats(accountId: string, fileDelta: number, bytesDelta: number): Promise<void> {
    await this.tx<DriveAccountRecord>(`driveAccounts/${safeKey(accountId)}`, (current) => {
      if (!current) return undefined;
      return {
        ...current,
        fileCount: Math.max(0, current.fileCount + fileDelta),
        totalBytes: Math.max(0, current.totalBytes + bytesDelta),
        updatedAt: Date.now(),
      };
    });
  }

  // ---- admins ------------------------------------------------------------
  async isAdmin(uid: string): Promise<boolean> {
    const v = await this.val<unknown>(`admins/${safeKey(uid)}`);
    return v !== null && v !== undefined;
  }

  async grantAdmin(uid: string, email: string | null, grantedBy: string | null): Promise<void> {
    await this.set(`admins/${safeKey(uid)}`, { email, grantedAt: Date.now(), grantedBy });
  }

  async revokeAdmin(uid: string): Promise<void> {
    await this.set(`admins/${safeKey(uid)}`, null);
  }

  async listAdminUids(): Promise<string[]> {
    const all = (await this.val<Record<string, unknown>>("admins")) ?? {};
    return Object.keys(all);
  }

  // ---- audit -------------------------------------------------------------
  async appendAudit(log: Omit<AuditLogRecord, "id" | "at"> & { at?: number }): Promise<AuditLogRecord> {
    const rec: AuditLogRecord = {
      ...log,
      id: newRecordId("log"),
      at: log.at ?? Date.now(),
    };
    await this.set(`auditLogs/${rec.id}`, rec);
    return rec;
  }

  async listAuditLogs(
    filter: { action?: string; actorUid?: string },
    page: PageQuery
  ): Promise<ListResult<AuditLogRecord>> {
    const all = (await this.val<Record<string, AuditLogRecord>>("auditLogs")) ?? {};
    let items = Object.values(all);
    if (filter.action) items = items.filter((l) => l.action.includes(filter.action!));
    if (filter.actorUid) items = items.filter((l) => l.actorUid === filter.actorUid);
    items.sort((a, b) => b.at - a.at);
    const total = items.length;
    return { items: items.slice(page.offset, page.offset + page.pageSize), total };
  }

  // ---- jobs --------------------------------------------------------------
  async recordCleanupRun(run: CleanupRunRecord): Promise<void> {
    await this.set(`cleanupRuns/${run.id}`, run);
  }

  async updateCleanupRun(id: string, patch: Partial<CleanupRunRecord>): Promise<void> {
    await this.update(`cleanupRuns/${safeKey(id)}`, patch as Record<string, unknown>);
  }

  async listCleanupRuns(limit: number): Promise<CleanupRunRecord[]> {
    const all = (await this.val<Record<string, CleanupRunRecord>>("cleanupRuns")) ?? {};
    return Object.values(all)
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, limit);
  }

  async getRetryEntry(fileId: string): Promise<CleanupRetryRecord | null> {
    return this.val<CleanupRetryRecord>(`cleanupRetries/${safeKey(fileId)}`);
  }

  async putRetryEntry(entry: CleanupRetryRecord): Promise<void> {
    await this.set(`cleanupRetries/${safeKey(entry.fileId)}`, entry);
  }

  async listRetryEntries(now: number, limit: number): Promise<CleanupRetryRecord[]> {
    const snap = await this.ref("cleanupRetries").orderByChild("nextAttemptAt").endAt(now).limitToFirst(limit).once("value");
    const all = (snap.val() ?? {}) as Record<string, CleanupRetryRecord>;
    return Object.values(all).sort((a, b) => a.nextAttemptAt - b.nextAttemptAt);
  }

  async deleteRetryEntry(fileId: string): Promise<void> {
    await this.set(`cleanupRetries/${safeKey(fileId)}`, null);
  }

  async countPendingRetries(): Promise<number> {
    const all = (await this.val<Record<string, unknown>>("cleanupRetries")) ?? {};
    return Object.keys(all).length;
  }

  // ---- app version -------------------------------------------------------
  async getAppVersion(): Promise<AppVersionRecord | null> {
    return this.val<AppVersionRecord>("appConfig/version");
  }

  async putAppVersion(rec: AppVersionRecord): Promise<void> {
    await this.set("appConfig/version", rec);
  }

  // ---- notifications -----------------------------------------------------
  async registerNotificationToken(t: NotificationTokenRecord): Promise<void> {
    await this.set(`notifTokens/${safeKey(t.uid)}/${safeKey(createHash("sha256").update(t.token).digest("hex").slice(0, 24))}`, t);
  }

  async listNotificationTokens(uid: string): Promise<NotificationTokenRecord[]> {
    const all = (await this.val<Record<string, NotificationTokenRecord>>(`notifTokens/${safeKey(uid)}`)) ?? {};
    return Object.values(all);
  }

  async markNotificationSent(rec: NotificationSentRecord): Promise<boolean> {
    const res = await this.tx<NotificationSentRecord>(`notifSent/${safeKey(rec.id)}`, (current) =>
      current ?? rec
    );
    return res.committed && res.value?.id === rec.id;
  }

  async listNotificationsSentForFile(fileId: string): Promise<NotificationSentRecord[]> {
    const all = (await this.val<Record<string, NotificationSentRecord>>("notifSent")) ?? {};
    return Object.values(all).filter((n) => n.fileId === fileId);
  }

  // ---- client API keys ---------------------------------------------------
  async createApiKey(rec: ApiKeyRecord): Promise<void> {
    await this.set(`apiKeys/${safeKey(rec.id)}`, rec);
  }

  async getApiKey(id: string): Promise<ApiKeyRecord | null> {
    const rec = await this.val<ApiKeyRecord>(`apiKeys/${safeKey(id)}`);
    return rec ? { ...rec, scopes: rec.scopes ?? [] } : null;
  }

  async listApiKeys(): Promise<ApiKeyRecord[]> {
    const all = (await this.val<Record<string, ApiKeyRecord>>("apiKeys")) ?? {};
    return Object.values(all)
      .map((k) => ({ ...k, scopes: k.scopes ?? [] }))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  async updateApiKey(id: string, patch: Partial<ApiKeyRecord>): Promise<ApiKeyRecord | null> {
    const res = await this.tx<ApiKeyRecord>(`apiKeys/${safeKey(id)}`, (current) => {
      if (!current) return undefined;
      return { ...current, ...patch };
    });
    return res.committed ? res.value : this.getApiKey(id);
  }

  async deleteApiKey(id: string): Promise<boolean> {
    const existing = await this.getApiKey(id);
    if (!existing) return false;
    await this.set(`apiKeys/${safeKey(id)}`, null);
    return true;
  }

  // ---- rate limiting -----------------------------------------------------
  async rateLimitHit(
    key: string,
    limit: number,
    windowSec: number
  ): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
    const now = Date.now();
    const windowMs = windowSec * 1000;
    const bucket = Math.floor(now / windowMs);
    const path = `rateLimits/${bucket}/${safeKey(key)}`;
    const res = await this.tx<{ count: number; resetAt: number }>(path, (current) => {
      const c = current ?? { count: 0, resetAt: (bucket + 1) * windowMs };
      return { ...c, count: c.count + 1 };
    });
    const count = res.value?.count ?? 1;
    return {
      allowed: count <= limit,
      remaining: Math.max(0, limit - count),
      resetAt: res.value?.resetAt ?? (bucket + 1) * windowMs,
    };
  }
}
