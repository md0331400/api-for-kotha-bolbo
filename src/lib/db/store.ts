import type {
  AppVersionRecord,
  AuditLogRecord,
  CleanupRetryRecord,
  CleanupRunRecord,
  DriveAccountRecord,
  DriveTokenRecord,
  FileCategory,
  FileRecord,
  FileStatus,
  NotificationSentRecord,
  NotificationTokenRecord,
  UploadSession,
  UserRecord,
} from "@/lib/db/types";

export type FileFilters = {
  uid?: string;
  category?: FileCategory;
  status?: FileStatus;
  expiringInDays?: number;
  createdAfter?: number;
  createdBefore?: number;
  q?: string;
  sort?: "createdAt" | "expiresAt" | "sizeBytes";
  order?: "asc" | "desc";
};

export type PageQuery = { page: number; pageSize: number; offset: number };

export type ListResult<T> = { items: T[]; total: number };

export type CreateUploadInput = {
  uid: string;
  category: FileCategory;
  name: string;
  mimeType: string;
  expectedBytes: number;
  idempotencyKey: string;
  ticketTtlMs: number;
  defaultQuotaBytes: number;
};

export type ConfirmUploadInput = {
  uploadId: string;
  uid: string;
  /** Provider-verified metadata. */
  providerFileId: string;
  verifiedName: string;
  verifiedMimeType: string;
  verifiedSizeBytes: number;
  verifiedParents: string[];
  managedFolderId: string | null;
  verifiedCreatedTime: number | null;
  /** File retention in days (product default: 60). */
  ttlDays: number;
};

export type QuotaSnapshot = {
  quotaBytes: number;
  usedBytes: number;
  reservedBytes: number;
  fileCount: number;
  remainingBytes: number;
  restricted: boolean;
};

/**
 * Persistent domain store. The production implementation targets the
 * Firebase Realtime Database (server-only) with transactional quota
 * reservations; an in-memory implementation with identical semantics exists
 * for tests. Persistent records must never live in process memory or files.
 */
export interface Store {
  ensureSchema(): Promise<void>;

  // ---- users -------------------------------------------------------------
  getUser(uid: string): Promise<UserRecord | null>;
  upsertUserOnLogin(p: {
    uid: string;
    email: string | null;
    displayName: string | null;
    photoURL: string | null;
  }): Promise<UserRecord>;
  listUsers(q: string | undefined, page: PageQuery): Promise<ListResult<UserRecord>>;
  setUserFields(
    uid: string,
    patch: { quotaBytes?: number; restricted?: boolean }
  ): Promise<UserRecord | null>;
  getQuotaSnapshot(uid: string): Promise<QuotaSnapshot | null>;

  // ---- uploads / quota ---------------------------------------------------
  createUploadSession(input: CreateUploadInput): Promise<{ session: UploadSession; reused: boolean }>;
  getUploadSession(uploadId: string): Promise<UploadSession | null>;
  /** Attach the chosen provider account + resumable session URL to a ticket. */
  assignUploadProvider(
    uploadId: string,
    input: { providerAccountId: string; providerSessionUrl: string }
  ): Promise<UploadSession | null>;
  markUploadUploaded(uploadId: string, providerFileId: string): Promise<UploadSession | null>;
  /** Idempotent: returns the existing file when the session is already confirmed. */
  confirmUpload(input: ConfirmUploadInput): Promise<{ file: FileRecord; reused: boolean }>;
  /** Idempotent release of a reservation (failure, expiry, abandonment). */
  releaseUploadReservation(uploadId: string, reason: string): Promise<{ released: boolean }>;
  listUploadsForCleanup(now: number, limit: number): Promise<UploadSession[]>;
  listFailedUploads(limit: number): Promise<UploadSession[]>;
  /** Authoritative recompute of counters from records (self-healing). */
  recomputeUserUsage(uid: string): Promise<QuotaSnapshot>;

  // ---- files -------------------------------------------------------------
  getFile(fileId: string): Promise<FileRecord | null>;
  listFiles(filters: FileFilters, page: PageQuery): Promise<ListResult<FileRecord>>;
  listExpiredFiles(now: number, limit: number): Promise<FileRecord[]>;
  listExpiringBetween(fromTs: number, toTs: number, limit: number): Promise<FileRecord[]>;
  updateFileRecord(
    fileId: string,
    patch: Partial<
      Pick<FileRecord, "status" | "deletedAt" | "deleteAttempts" | "lastDeleteError" | "deletedBy">
    >
  ): Promise<FileRecord | null>;
  purgeUserFiles(uid: string, limit: number): Promise<number>;

  // ---- drive accounts ----------------------------------------------------
  listDriveAccounts(): Promise<DriveAccountRecord[]>;
  getDriveAccount(id: string): Promise<DriveAccountRecord | null>;
  createDriveAccount(input: {
    accountEmail: string | null;
    displayName: string | null;
    scope: string;
  }): Promise<DriveAccountRecord>;
  updateDriveAccount(
    id: string,
    patch: Partial<
      Pick<
        DriveAccountRecord,
        | "status"
        | "verified"
        | "accountEmail"
        | "displayName"
        | "lastSuccessAt"
        | "lastErrorAt"
        | "lastErrorMessage"
        | "fileCount"
        | "totalBytes"
        | "quotaInfo"
        | "managedFolderId"
        | "disabledReason"
      >
    >
  ): Promise<DriveAccountRecord | null>;
  saveDriveToken(t: DriveTokenRecord): Promise<void>;
  getDriveToken(accountId: string): Promise<DriveTokenRecord | null>;
  deleteDriveToken(accountId: string): Promise<void>;
  /** Atomic single-claim of a provider object; false when already claimed. */
  claimProviderFile(accountId: string, providerFileId: string, fileId: string): Promise<boolean>;
  getProviderClaim(accountId: string, providerFileId: string): Promise<string | null>;
  addAccountStats(accountId: string, fileDelta: number, bytesDelta: number): Promise<void>;

  // ---- admins ------------------------------------------------------------
  isAdmin(uid: string): Promise<boolean>;
  grantAdmin(uid: string, email: string | null, grantedBy: string | null): Promise<void>;
  revokeAdmin(uid: string): Promise<void>;
  listAdminUids(): Promise<string[]>;

  // ---- audit -------------------------------------------------------------
  appendAudit(
    log: Omit<AuditLogRecord, "id" | "at"> & { at?: number }
  ): Promise<AuditLogRecord>;
  listAuditLogs(
    filter: { action?: string; actorUid?: string },
    page: PageQuery
  ): Promise<ListResult<AuditLogRecord>>;

  // ---- jobs --------------------------------------------------------------
  recordCleanupRun(run: CleanupRunRecord): Promise<void>;
  updateCleanupRun(id: string, patch: Partial<CleanupRunRecord>): Promise<void>;
  listCleanupRuns(limit: number): Promise<CleanupRunRecord[]>;
  getRetryEntry(fileId: string): Promise<CleanupRetryRecord | null>;
  putRetryEntry(entry: CleanupRetryRecord): Promise<void>;
  listRetryEntries(now: number, limit: number): Promise<CleanupRetryRecord[]>;
  deleteRetryEntry(fileId: string): Promise<void>;
  countPendingRetries(): Promise<number>;

  // ---- app version -------------------------------------------------------
  getAppVersion(): Promise<AppVersionRecord | null>;
  putAppVersion(rec: AppVersionRecord): Promise<void>;

  // ---- notifications -----------------------------------------------------
  registerNotificationToken(t: NotificationTokenRecord): Promise<void>;
  listNotificationTokens(uid: string): Promise<NotificationTokenRecord[]>;
  markNotificationSent(rec: NotificationSentRecord): Promise<boolean>;
  listNotificationsSentForFile(fileId: string): Promise<NotificationSentRecord[]>;

  // ---- rate limiting -----------------------------------------------------
  rateLimitHit(
    key: string,
    limit: number,
    windowSec: number
  ): Promise<{ allowed: boolean; remaining: number; resetAt: number }>;
}
