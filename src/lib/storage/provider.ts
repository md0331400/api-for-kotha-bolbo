import type { Readable } from "node:stream";

/** Provider-verified metadata for a stored object. */
export type ProviderFileMeta = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  parents: string[];
  createdTime: number | null;
  trashed: boolean;
};

export type ResumableUploadSession = {
  /** Short-lived, single-object upload URL handed to the authenticated client. */
  uploadUrl: string;
  /** Absolute expiry (ms epoch) after which the session must not be used. */
  expiresAt: number;
  /** The provider file id is unknown until the upload completes. */
  method: "PUT";
  headers: Record<string, string>;
};

export type ProviderQuota = {
  limitBytes: number | null;
  usageBytes: number | null;
  usageInDriveBytes: number | null;
};

export type DownloadHandle = {
  stream: Readable;
  contentType: string;
  contentLength: number | null;
  fileName: string;
  status: number;
};

/**
 * Storage provider abstraction. The production implementation targets Google
 * Drive (one connected account per instance). A test-only fake implements the
 * same surface. Permanent credentials never leave the server.
 */
export interface StorageProvider {
  /** Human-identifiable account info (email/name), never tokens. */
  getIdentity(): Promise<{ email: string | null; displayName: string | null }>;

  /** Ensure the managed folder that owns every object created by this app. */
  ensureManagedFolder(): Promise<{ id: string }>;

  createResumableUpload(input: {
    name: string;
    mimeType: string;
    sizeBytes: number;
    parentId: string;
  }): Promise<ResumableUploadSession>;

  getFileMeta(providerFileId: string): Promise<ProviderFileMeta | null>;

  /** Idempotent: deleting a missing object counts as success. */
  deleteFile(providerFileId: string): Promise<{ deleted: boolean }>;

  download(providerFileId: string, range?: { start: number; end?: number }): Promise<DownloadHandle>;

  /** Returns null unless the provider reports capacity reliably. */
  getQuota(): Promise<ProviderQuota | null>;

  /** Creates and removes a zero-byte object to verify write access. */
  testOperation(parentId: string): Promise<void>;
}
