import { createHash, randomBytes } from "node:crypto";
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
import { ApiError } from "@/lib/errors";

const nowFn = () => Date.now();

function idemHash(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 32);
}

function newRecordId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString("base64url")}`;
}

function matchQ(haystacks: Array<string | null | undefined>, q: string): boolean {
  const needle = q.toLowerCase();
  return haystacks.some((h) => (h ?? "").toLowerCase().includes(needle));
}

/**
 * In-memory implementation of {@link Store} used by unit tests. Operations are
 * serialized through a mutex so transactions behave like the Realtime
 * Database's serialized transactions. NOT used for persistent records.
 */
export class MemoryStore implements Store {
  private mutex: Promise<unknown> = Promise.resolve();
  users = new Map<string, UserRecord>();
  files = new Map<string, FileRecord>();
  filesByUid = new Map<string, Set<string>>();
  uploads = new Map<string, UploadSession>();
  uploadsByIdem = new Map<string, string>(); // uid|hash -> uploadId
  driveAccounts = new Map<string, DriveAccountRecord>();
  driveTokens = new Map<string, DriveTokenRecord>();
  driveIdentities = new Map<string, string>(); // identityKey -> accountId
  apiKeys = new Map<string, ApiKeyRecord>();
  providerClaims = new Map<string, string>(); // accountId|providerFileId -> fileId
  admins = new Map<string, { email: string | null; grantedAt: number; grantedBy: string | null }>();
  auditLogs: AuditLogRecord[] = [];
  cleanupRuns = new Map<string, CleanupRunRecord>();
  retryEntries = new Map<string, CleanupRetryRecord>();
  appVersion: AppVersionRecord | null = null;
  notifTokens = new Map<string, NotificationTokenRecord[]>();
  notifSent = new Map<string, NotificationSentRecord>();
  rateBuckets = new Map<string, { count: number; resetAt: number }>();
  schemaReady = false;

  /** Serialize all mutating sections like DB transactions. */
  private run<T>(fn: () => T | Promise<T>): Promise<T> {
    const next = this.mutex.then(fn, fn);
    this.mutex = next.catch(() => undefined);
    return next;
  }

  async ensureSchema(): Promise<void> {
    this.schemaReady = true;
  }

  // ---- users -------------------------------------------------------------
  private defaultUser(
    uid: string,
    email: string | null,
    displayName: string | null,
    photoURL: string | null
  ): UserRecord {
    return {
      uid,
      email,
      displayName,
      photoURL,
      quotaBytes: 2 * 1024 * 1024 * 1024,
      usedBytes: 0,
      reservedBytes: 0,
      fileCount: 0,
      restricted: false,
      createdAt: nowFn(),
      updatedAt: nowFn(),
      lastLoginAt: nowFn(),
    };
  }

  async getUser(uid: string) {
    return this.users.get(uid) ?? null;
  }

  async upsertUserOnLogin(p: {
    uid: string;
    email: string | null;
    displayName: string | null;
    photoURL: string | null;
  }) {
    return this.run(() => {
      const existing = this.users.get(p.uid);
      if (existing) {
        existing.email = p.email ?? existing.email;
        existing.displayName = p.displayName ?? existing.displayName;
        existing.photoURL = p.photoURL ?? existing.photoURL;
        existing.lastLoginAt = nowFn();
        existing.updatedAt = nowFn();
        return { ...existing };
      }
      const user = this.defaultUser(p.uid, p.email, p.displayName, p.photoURL);
      this.users.set(p.uid, user);
      return { ...user };
    });
  }

  async listUsers(q: string | undefined, page: PageQuery): Promise<ListResult<UserRecord>> {
    let all = [...this.users.values()];
    if (q) all = all.filter((u) => matchQ([u.uid, u.email, u.displayName], q));
    all.sort((a, b) => b.createdAt - a.createdAt);
    return { items: all.slice(page.offset, page.offset + page.pageSize).map((u) => ({ ...u })), total: all.length };
  }

  async setUserFields(uid: string, patch: { quotaBytes?: number; restricted?: boolean }) {
    return this.run(() => {
      const u = this.users.get(uid);
      if (!u) return null;
      if (patch.quotaBytes !== undefined) u.quotaBytes = patch.quotaBytes;
      if (patch.restricted !== undefined) u.restricted = patch.restricted;
      u.updatedAt = nowFn();
      return { ...u };
    });
  }

  async getQuotaSnapshot(uid: string): Promise<QuotaSnapshot | null> {
    const u = this.users.get(uid);
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

  // ---- uploads -----------------------------------------------------------
  async createUploadSession(input: CreateUploadInput) {
    return this.run(() => {
      const now = nowFn();
      const hash = idemHash(input.idempotencyKey);
      const key = `${input.uid}|${hash}`;
      const existingId = this.uploadsByIdem.get(key);
      if (existingId) {
        const s = this.uploads.get(existingId);
        if (s) return { session: { ...s }, reused: true };
        this.uploadsByIdem.delete(key); // stale pointer — repair
      }

      let user = this.users.get(input.uid);
      if (!user) {
        user = this.defaultUser(input.uid, null, null, null);
        user.quotaBytes = input.defaultQuotaBytes;
        this.users.set(input.uid, user);
      }
      if (user.restricted) {
        throw new ApiError("FORBIDDEN", "Storage access is restricted for this account.");
      }

      const id = newRecordId("up");
      const fileId = newRecordId("file");
      const session: UploadSession & { reservationCounted?: boolean } = {
        id,
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
      };

      // Quota reservation (transactional section).
      const remaining = user.quotaBytes - user.usedBytes - user.reservedBytes;
      if (input.expectedBytes > remaining) {
        // Failed reservations are NOT idempotent-sticky: a later retry with the
        // same key may succeed once quota is available.
        session.status = "failed";
        session.error = "QUOTA_EXCEEDED";
        this.uploads.set(id, session);
        throw new ApiError("QUOTA_EXCEEDED", "Insufficient storage quota for this upload.", {
          details: {
            quotaBytes: user.quotaBytes,
            usedBytes: user.usedBytes,
            reservedBytes: user.reservedBytes,
            requestedBytes: input.expectedBytes,
            remainingBytes: Math.max(0, remaining),
          },
        });
      }
      user.reservedBytes += input.expectedBytes;
      user.updatedAt = now;
      session.reservationCounted = true;
      this.uploads.set(id, session);
      this.uploadsByIdem.set(key, id);
      return { session: { ...session }, reused: false };
    });
  }

  async getUploadSession(uploadId: string) {
    const s = this.uploads.get(uploadId);
    return s ? { ...s } : null;
  }

  async assignUploadProvider(
    uploadId: string,
    input: { providerAccountId: string; providerSessionUrl: string }
  ) {
    return this.run(() => {
      const s = this.uploads.get(uploadId);
      if (!s) return null;
      if (s.status === "reserved" && !s.providerAccountId) {
        s.providerAccountId = input.providerAccountId;
        s.providerSessionUrl = input.providerSessionUrl;
        s.updatedAt = nowFn();
      }
      return { ...s };
    });
  }

  async markUploadUploaded(uploadId: string, providerFileId: string) {
    return this.run(() => {
      const s = this.uploads.get(uploadId);
      if (!s) return null;
      if (s.status === "reserved") {
        s.status = "uploaded";
        s.providerFileId = providerFileId;
        s.updatedAt = nowFn();
      }
      return { ...s };
    });
  }

  async confirmUpload(input: ConfirmUploadInput): Promise<{ file: FileRecord; reused: boolean }> {
    return this.run(() => {
      const s = this.uploads.get(input.uploadId);
      if (!s) throw new ApiError("NOT_FOUND", "Upload session not found.");
      if (s.uid !== input.uid) throw new ApiError("FORBIDDEN", "Upload session belongs to another user.");

      if (s.status === "confirmed" && s.fileId) {
        const f = this.files.get(s.fileId);
        if (f) return { file: { ...f }, reused: true };
      }
      if (s.status === "released" || s.status === "failed") {
        throw new ApiError("UPLOAD_NOT_CONFIRMED", "Upload session is no longer active.");
      }

      const now = nowFn();
      // Single-claim of the provider object (prevents duplicate registrations).
      const claimKey = `${s.providerAccountId ?? "none"}|${input.providerFileId}`;
      const claimedBy = this.providerClaims.get(claimKey);
      if (claimedBy && claimedBy !== s.fileId) {
        throw new ApiError("DUPLICATE", "This provider object is already registered.");
      }
      this.providerClaims.set(claimKey, s.fileId!);

      if (input.verifiedSizeBytes > s.expectedBytes) {
        this.releaseInternal(s, "SIZE_MISMATCH");
        throw new ApiError("BAD_REQUEST", "Uploaded object is larger than the reserved size.", {
          details: { expectedBytes: s.expectedBytes, actualBytes: input.verifiedSizeBytes },
        });
      }

      const file: FileRecord = {
        id: s.fileId!,
        uid: s.uid,
        category: s.category,
        name: input.verifiedName || s.name,
        mimeType: input.verifiedMimeType || s.mimeType,
        sizeBytes: input.verifiedSizeBytes,
        createdAt: now,
        expiresAt: now + input.ttlDays * 86_400_000,
        providerAccountId: s.providerAccountId!,
        providerFileId: input.providerFileId,
        status: "confirmed",
        uploadId: s.id,
      };

      const user = this.users.get(s.uid);
      if (user) {
        if (s.reservationCounted) user.reservedBytes = Math.max(0, user.reservedBytes - s.reservedBytes);
        user.usedBytes += file.sizeBytes;
        user.fileCount += 1;
        user.updatedAt = now;
      }
      s.reservationCounted = false;
      s.status = "confirmed";
      s.fileId = file.id;
      s.providerFileId = input.providerFileId;
      s.updatedAt = now;

      this.files.set(file.id, file);
      let set = this.filesByUid.get(s.uid);
      if (!set) {
        set = new Set();
        this.filesByUid.set(s.uid, set);
      }
      set.add(file.id);

      const acct = s.providerAccountId ? this.driveAccounts.get(s.providerAccountId) : undefined;
      if (acct) {
        acct.fileCount += 1;
        acct.totalBytes += file.sizeBytes;
        acct.lastSuccessAt = now;
        acct.verified = true;
      }
      return { file: { ...file }, reused: false };
    });
  }

  private releaseInternal(s: UploadSession, reason: string) {
    if (s.status === "confirmed" || s.status === "released") return { released: false };
    const counted = s.reservationCounted;
    const user = this.users.get(s.uid);
    if (counted && user) {
      user.reservedBytes = Math.max(0, user.reservedBytes - s.reservedBytes);
      user.updatedAt = nowFn();
    }
    s.reservationCounted = false;
    s.status = "released";
    s.error = reason;
    s.updatedAt = nowFn();
    return { released: true };
  }

  async releaseUploadReservation(uploadId: string, reason: string) {
    return this.run(() => {
      const s = this.uploads.get(uploadId);
      if (!s) return { released: false };
      return this.releaseInternal(s, reason);
    });
  }

  async listUploadsForCleanup(now: number, limit: number) {
    return [...this.uploads.values()]
      .filter((s) => (s.status === "reserved" || s.status === "uploaded") && s.ticketExpiresAt <= now)
      .sort((a, b) => a.ticketExpiresAt - b.ticketExpiresAt)
      .slice(0, limit)
      .map((s) => ({ ...s }));
  }

  async listFailedUploads(limit: number) {
    return [...this.uploads.values()]
      .filter((s) => s.status === "failed" || s.status === "released")
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit)
      .map((s) => ({ ...s }));
  }

  async recomputeUserUsage(uid: string): Promise<QuotaSnapshot> {
    return this.run(() => {
      const user = this.users.get(uid);
      if (!user) throw new ApiError("NOT_FOUND", "User not found.");
      const now = nowFn();
      let used = 0;
      let count = 0;
      for (const f of this.files.values()) {
        if (f.uid === uid && f.status === "confirmed") {
          used += f.sizeBytes;
          count += 1;
        }
      }
      let reserved = 0;
      for (const s of this.uploads.values()) {
        if (
          s.uid === uid &&
          (s.status === "reserved" || s.status === "uploaded") &&
          s.ticketExpiresAt > now &&
          s.reservationCounted !== false
        ) {
          reserved += s.reservedBytes;
        }
      }
      user.usedBytes = used;
      user.fileCount = count;
      user.reservedBytes = reserved;
      user.updatedAt = now;
      return {
        quotaBytes: user.quotaBytes,
        usedBytes: used,
        reservedBytes: reserved,
        fileCount: count,
        remainingBytes: Math.max(0, user.quotaBytes - used - reserved),
        restricted: user.restricted,
      };
    });
  }

  // ---- files -------------------------------------------------------------
  async getFile(fileId: string) {
    const f = this.files.get(fileId);
    return f ? { ...f } : null;
  }

  async listFiles(filters: FileFilters, page: PageQuery): Promise<ListResult<FileRecord>> {
    let all = [...this.files.values()];
    if (filters.uid) all = all.filter((f) => f.uid === filters.uid);
    if (filters.category) all = all.filter((f) => f.category === filters.category);
    if (filters.status) all = all.filter((f) => f.status === filters.status);
    if (filters.createdAfter !== undefined) all = all.filter((f) => f.createdAt >= filters.createdAfter!);
    if (filters.createdBefore !== undefined) all = all.filter((f) => f.createdAt <= filters.createdBefore!);
    if (filters.expiringInDays !== undefined) {
      const until = nowFn() + filters.expiringInDays * 86_400_000;
      all = all.filter((f) => f.expiresAt <= until && f.status !== "deleted");
    }
    const q = filters.q;
    if (q) all = all.filter((f) => matchQ([f.id, f.name, f.providerFileId], q));
    const sortKey = filters.sort ?? "createdAt";
    const dir = filters.order === "asc" ? 1 : -1;
    all.sort((a, b) => (a[sortKey] - b[sortKey]) * dir);
    return {
      items: all.slice(page.offset, page.offset + page.pageSize).map((f) => ({ ...f })),
      total: all.length,
    };
  }

  async listExpiredFiles(now: number, limit: number) {
    return [...this.files.values()]
      .filter((f) => f.status === "confirmed" && f.expiresAt <= now)
      .sort((a, b) => a.expiresAt - b.expiresAt)
      .slice(0, limit)
      .map((f) => ({ ...f }));
  }

  async listExpiringBetween(fromTs: number, toTs: number, limit: number) {
    return [...this.files.values()]
      .filter((f) => f.status === "confirmed" && f.expiresAt >= fromTs && f.expiresAt <= toTs)
      .sort((a, b) => a.expiresAt - b.expiresAt)
      .slice(0, limit)
      .map((f) => ({ ...f }));
  }

  async updateFileRecord(fileId: string, patch: Partial<FileRecord>) {
    return this.run(() => {
      const f = this.files.get(fileId);
      if (!f) return null;
      const before = f.status;
      Object.assign(f, patch);
      if (before !== "deleted" && f.status === "deleted") {
        const user = this.users.get(f.uid);
        if (user) {
          user.usedBytes = Math.max(0, user.usedBytes - f.sizeBytes);
          user.fileCount = Math.max(0, user.fileCount - 1);
          user.updatedAt = nowFn();
        }
        const acct = this.driveAccounts.get(f.providerAccountId);
        if (acct) {
          acct.fileCount = Math.max(0, acct.fileCount - 1);
          acct.totalBytes = Math.max(0, acct.totalBytes - f.sizeBytes);
        }
      }
      return { ...f };
    });
  }

  async purgeUserFiles(uid: string, limit: number) {
    return this.run(() => {
      let n = 0;
      for (const f of this.files.values()) {
        if (f.uid === uid && (f.status === "confirmed" || f.status === "delete_failed")) {
          f.status = "pending_delete";
          n += 1;
          if (n >= limit) break;
        }
      }
      return n;
    });
  }

  // ---- drive -------------------------------------------------------------
  async listDriveAccounts() {
    return [...this.driveAccounts.values()].map((a) => ({ ...a }));
  }

  async getDriveAccount(id: string) {
    const a = this.driveAccounts.get(id);
    return a ? { ...a } : null;
  }

  async createDriveAccount(input: {
    accountEmail: string | null;
    displayName: string | null;
    scope: string;
    id?: string;
    googleAccountId?: string | null;
  }) {
    return this.run(() => {
      const now = nowFn();
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
      this.driveAccounts.set(rec.id, rec);
      return { ...rec };
    });
  }

  async claimDriveIdentity(identityKey: string, accountId: string) {
    return this.run(() => {
      const existing = this.driveIdentities.get(identityKey);
      if (existing) return existing;
      this.driveIdentities.set(identityKey, accountId);
      return accountId;
    });
  }

  async getDriveIdentityOwner(identityKey: string) {
    return this.driveIdentities.get(identityKey) ?? null;
  }

  async updateDriveAccount(id: string, patch: Partial<DriveAccountRecord>) {
    return this.run(() => {
      const a = this.driveAccounts.get(id);
      if (!a) return null;
      Object.assign(a, patch, { updatedAt: nowFn() });
      return { ...a };
    });
  }

  async saveDriveToken(t: DriveTokenRecord) {
    await this.run(() => {
      this.driveTokens.set(t.accountId, { ...t });
    });
  }

  async getDriveToken(accountId: string) {
    const t = this.driveTokens.get(accountId);
    return t ? { ...t } : null;
  }

  async deleteDriveToken(accountId: string) {
    await this.run(() => {
      this.driveTokens.delete(accountId);
    });
  }

  async claimProviderFile(accountId: string, providerFileId: string, fileId: string) {
    return this.run(() => {
      const key = `${accountId}|${providerFileId}`;
      const existing = this.providerClaims.get(key);
      if (existing === fileId) return true;
      if (existing) return false;
      this.providerClaims.set(key, fileId);
      return true;
    });
  }

  async getProviderClaim(accountId: string, providerFileId: string) {
    return this.providerClaims.get(`${accountId}|${providerFileId}`) ?? null;
  }

  async addAccountStats(accountId: string, fileDelta: number, bytesDelta: number) {
    await this.run(() => {
      const a = this.driveAccounts.get(accountId);
      if (!a) return;
      a.fileCount = Math.max(0, a.fileCount + fileDelta);
      a.totalBytes = Math.max(0, a.totalBytes + bytesDelta);
      a.updatedAt = nowFn();
    });
  }

  // ---- admins ------------------------------------------------------------
  async isAdmin(uid: string) {
    return this.admins.has(uid);
  }

  async grantAdmin(uid: string, email: string | null, grantedBy: string | null) {
    await this.run(() => {
      this.admins.set(uid, { email, grantedAt: nowFn(), grantedBy });
    });
  }

  async revokeAdmin(uid: string) {
    await this.run(() => {
      this.admins.delete(uid);
    });
  }

  async listAdminUids() {
    return [...this.admins.keys()];
  }

  // ---- audit -------------------------------------------------------------
  async appendAudit(log: Omit<AuditLogRecord, "id" | "at"> & { at?: number }) {
    return this.run(() => {
      const rec: AuditLogRecord = {
        ...log,
        id: newRecordId("log"),
        at: log.at ?? nowFn(),
      };
      this.auditLogs.unshift(rec);
      return { ...rec };
    });
  }

  async listAuditLogs(filter: { action?: string; actorUid?: string }, page: PageQuery) {
    let all = [...this.auditLogs];
    if (filter.action) all = all.filter((l) => l.action.includes(filter.action!));
    if (filter.actorUid) all = all.filter((l) => l.actorUid === filter.actorUid);
    return { items: all.slice(page.offset, page.offset + page.pageSize).map((l) => ({ ...l })), total: all.length };
  }

  // ---- jobs --------------------------------------------------------------
  async recordCleanupRun(run: CleanupRunRecord) {
    await this.run(() => {
      this.cleanupRuns.set(run.id, { ...run });
    });
  }

  async updateCleanupRun(id: string, patch: Partial<CleanupRunRecord>) {
    await this.run(() => {
      const r = this.cleanupRuns.get(id);
      if (r) Object.assign(r, patch);
    });
  }

  async listCleanupRuns(limit: number) {
    return [...this.cleanupRuns.values()]
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }

  async getRetryEntry(fileId: string) {
    const e = this.retryEntries.get(fileId);
    return e ? { ...e } : null;
  }

  async putRetryEntry(entry: CleanupRetryRecord) {
    await this.run(() => {
      this.retryEntries.set(entry.fileId, { ...entry });
    });
  }

  async listRetryEntries(now: number, limit: number) {
    return [...this.retryEntries.values()]
      .filter((e) => e.nextAttemptAt <= now)
      .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt)
      .slice(0, limit)
      .map((e) => ({ ...e }));
  }

  async deleteRetryEntry(fileId: string) {
    await this.run(() => {
      this.retryEntries.delete(fileId);
    });
  }

  async countPendingRetries() {
    return this.retryEntries.size;
  }

  // ---- app version -------------------------------------------------------
  async getAppVersion() {
    return this.appVersion ? { ...this.appVersion } : null;
  }

  async putAppVersion(rec: AppVersionRecord) {
    await this.run(() => {
      this.appVersion = { ...rec };
    });
  }

  // ---- notifications -----------------------------------------------------
  async registerNotificationToken(t: NotificationTokenRecord) {
    await this.run(() => {
      const list = this.notifTokens.get(t.uid) ?? [];
      const idx = list.findIndex((x) => x.token === t.token);
      if (idx >= 0) list[idx] = { ...t };
      else list.push({ ...t });
      this.notifTokens.set(t.uid, list);
    });
  }

  async listNotificationTokens(uid: string) {
    return (this.notifTokens.get(uid) ?? []).map((t) => ({ ...t }));
  }

  async markNotificationSent(rec: NotificationSentRecord) {
    return this.run(() => {
      if (this.notifSent.has(rec.id)) return false;
      this.notifSent.set(rec.id, { ...rec });
      return true;
    });
  }

  async listNotificationsSentForFile(fileId: string) {
    return [...this.notifSent.values()].filter((n) => n.fileId === fileId).map((n) => ({ ...n }));
  }

  // ---- client API keys ---------------------------------------------------
  async createApiKey(rec: ApiKeyRecord) {
    await this.run(() => {
      this.apiKeys.set(rec.id, { ...rec, scopes: [...rec.scopes] });
    });
  }

  async getApiKey(id: string) {
    const k = this.apiKeys.get(id);
    return k ? { ...k, scopes: [...k.scopes] } : null;
  }

  async listApiKeys() {
    return [...this.apiKeys.values()]
      .map((k) => ({ ...k, scopes: [...k.scopes] }))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  async updateApiKey(id: string, patch: Partial<ApiKeyRecord>) {
    return this.run(() => {
      const k = this.apiKeys.get(id);
      if (!k) return null;
      Object.assign(k, patch);
      return { ...k, scopes: [...k.scopes] };
    });
  }

  async deleteApiKey(id: string) {
    return this.run(() => this.apiKeys.delete(id));
  }

  // ---- rate limit --------------------------------------------------------
  async rateLimitHit(key: string, limit: number, windowSec: number) {
    return this.run(() => {
      const now = nowFn();
      const windowMs = windowSec * 1000;
      const bucket = Math.floor(now / windowMs);
      const bkey = `${bucket}|${key}`;
      let b = this.rateBuckets.get(bkey);
      if (!b || b.resetAt <= now) {
        b = { count: 0, resetAt: (bucket + 1) * windowMs };
        this.rateBuckets.set(bkey, b);
      }
      b.count += 1;
      return {
        allowed: b.count <= limit,
        remaining: Math.max(0, limit - b.count),
        resetAt: b.resetAt,
      };
    });
  }
}
