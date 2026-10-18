/** Domain records stored in the persistent database (Firebase Realtime DB). */

export const FILE_CATEGORIES = ["chat", "voice", "photo", "video", "other"] as const;
export type FileCategory = (typeof FILE_CATEGORIES)[number];

export type FileStatus =
  | "pending_delete"
  | "confirmed"
  | "deleted"
  | "delete_failed";

export type UploadStatus =
  | "reserved" // quota reserved, waiting for provider upload
  | "uploaded" // client reported completion, waiting for confirm verification
  | "confirmed" // metadata persisted; quota finalized
  | "released" // reservation released (failure/expiry) — terminal
  | "failed"; // terminal failure

export type DriveAccountStatus = "enabled" | "disabled" | "disconnected" | "error";

export interface UserRecord {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
  quotaBytes: number;
  usedBytes: number;
  reservedBytes: number;
  fileCount: number;
  /** When true the user cannot request uploads. */
  restricted: boolean;
  createdAt: number;
  updatedAt: number;
  lastLoginAt: number;
}

export interface FileRecord {
  id: string;
  uid: string;
  category: FileCategory;
  /** Validated display filename. */
  name: string;
  mimeType: string;
  /** Verified size in bytes from the provider. */
  sizeBytes: number;
  createdAt: number;
  expiresAt: number;
  providerAccountId: string;
  providerFileId: string;
  status: FileStatus;
  /** Upload session that produced this file. */
  uploadId: string;
  deletedAt?: number;
  deleteAttempts?: number;
  lastDeleteError?: string;
  /** Set when an admin deleted the file. */
  deletedBy?: string;
}

export interface UploadSession {
  id: string;
  uid: string;
  category: FileCategory;
  name: string;
  mimeType: string;
  expectedBytes: number;
  reservedBytes: number;
  status: UploadStatus;
  idempotencyKey: string;
  providerAccountId: string | null;
  providerSessionUrl: string | null;
  providerFileId: string | null;
  fileId: string | null;
  createdAt: number;
  /** Ticket expiry; reservations older than this are cleaned up. */
  ticketExpiresAt: number;
  updatedAt: number;
  /**
   * True while the reservation is counted in users/{uid}.reservedBytes.
   * Set false once the reservation is consumed (confirm) or released.
   */
  reservationCounted?: boolean;
  error?: string;
}

export interface DriveQuotaInfo {
  limitBytes: number | null;
  usageBytes: number | null;
  usageInDriveBytes: number | null;
  fetchedAt: number;
}

export interface DriveAccountRecord {
  id: string;
  /** Google account email, shown in the dashboard. */
  accountEmail: string | null;
  displayName: string | null;
  status: DriveAccountStatus;
  /** False until a real provider operation has succeeded. */
  verified: boolean;
  connectedAt: number;
  updatedAt: number;
  lastSuccessAt: number | null;
  lastErrorAt: number | null;
  lastErrorMessage: string | null;
  fileCount: number;
  totalBytes: number;
  /** Only populated when the provider reports it reliably. */
  quotaInfo: DriveQuotaInfo | null;
  /** Folder in the connected account that owns every managed object. */
  managedFolderId: string | null;
  disabledReason: string | null;
  /**
   * Google's stable, immutable account identifier (`sub` from verified user
   * info). Optional for records created before duplicate protection existed.
   */
  googleAccountId?: string | null;
  /** Lower-cased, trimmed account email used as the secondary duplicate key. */
  normalizedEmail?: string | null;
}

export interface DriveTokenRecord {
  accountId: string;
  /** Refresh token — stored server-side only, optionally AES-GCM encrypted. */
  refreshToken: string;
  scope: string;
  obtainedAt: number;
  raw?: Record<string, unknown>;
}

/** Permission scopes that a client API key may be granted. */
export const API_KEY_SCOPES = [
  "storage:read",
  "storage:write",
  "storage:delete",
  "notifications:write",
] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export type ApiKeyStatus = "active" | "revoked";

/**
 * Client API key metadata. Only a SHA-256 hash of the secret is stored — the
 * raw key is shown once at creation and can never be recovered.
 */
export interface ApiKeyRecord {
  /** Public identifier embedded in the key (`ak_…`). */
  id: string;
  name: string;
  /** Firebase UID the key acts on behalf of (ownership/quota subject). */
  subjectUid: string;
  scopes: ApiKeyScope[];
  /** Hex SHA-256 of the full raw key. */
  secretHash: string;
  /** Non-secret display prefix, e.g. `kb_ak_3fT9…`. */
  prefix: string;
  status: ApiKeyStatus;
  createdAt: number;
  createdBy: string;
  createdByEmail: string | null;
  lastUsedAt: number | null;
  revokedAt: number | null;
  revokedBy: string | null;
  /** Optional absolute expiry (ms epoch). */
  expiresAt: number | null;
}

export interface AuditLogRecord {
  id: string;
  at: number;
  actorUid: string | null;
  actorEmail: string | null;
  /** e.g. user.quota.change, drive.disconnect, file.delete */
  action: string;
  targetType: string;
  targetId: string;
  requestId: string | null;
  details: Record<string, unknown>;
}

export interface CleanupRunRecord {
  id: string;
  startedAt: number;
  finishedAt: number | null;
  status: "running" | "success" | "partial" | "failed";
  scanned: number;
  deleted: number;
  reservationReleased: number;
  notified: number;
  failed: number;
  errors: Array<{ fileId?: string; message: string }>;
  triggeredBy: string;
}

export interface CleanupRetryRecord {
  fileId: string;
  attempts: number;
  nextAttemptAt: number;
  lastError: string;
  updatedAt: number;
}

export interface AppVersionRecord {
  currentVersion: string;
  minSupportedVersion: string;
  updateUrl: string;
  forceUpdate: boolean;
  releaseNotes: string | null;
  publishedAt: number;
  publishedBy: string | null;
}

export interface NotificationTokenRecord {
  uid: string;
  token: string;
  platform: string | null;
  updatedAt: number;
}

export interface NotificationSentRecord {
  id: string; // `${fileId}_${days}`
  uid: string;
  fileId: string;
  daysBefore: number;
  sentAt: number;
  status: "sent" | "skipped" | "failed";
}

/** Public JSON shapes returned by the API (camelCase, ISO timestamps). */

export type PublicFile = {
  id: string;
  category: FileCategory;
  name: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
  expiresAt: string;
  status: FileStatus;
  daysUntilExpiry: number;
};

export function toPublicFile(f: FileRecord, now = Date.now()): PublicFile {
  return {
    id: f.id,
    category: f.category,
    name: f.name,
    mimeType: f.mimeType,
    sizeBytes: f.sizeBytes,
    createdAt: new Date(f.createdAt).toISOString(),
    expiresAt: new Date(f.expiresAt).toISOString(),
    status: f.status,
    daysUntilExpiry: Math.ceil((f.expiresAt - now) / 86_400_000),
  };
}
