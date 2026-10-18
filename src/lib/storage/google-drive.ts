/**
 * Google Drive REST provider (server-only). Uses plain fetch against the
 * official Drive API v3 — no permanent credentials ever leave the server, and
 * access tokens are minted from stored refresh tokens per request window.
 */
import { Readable } from "node:stream";
import { ApiError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import type {
  DownloadHandle,
  ProviderFileMeta,
  ProviderQuota,
  ResumableUploadSession,
  StorageProvider,
} from "@/lib/storage/provider";

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
export const MANAGED_FOLDER_NAME = "Kotha Bolbo Storage";
const FOLDER_MIME = "application/vnd.google-apps.folder";

type GoogleErrorBody = {
  error?: {
    code?: number;
    status?: string;
    message?: string;
    errors?: Array<{ reason?: string; message?: string }>;
  };
};

function mapGoogleError(status: number, body: GoogleErrorBody, context: string): ApiError {
  const reason = body.error?.errors?.[0]?.reason ?? "";
  const msg = body.error?.message ?? `Google Drive error (${status})`;
  const safe = `${context}: ${msg}${reason ? ` [${reason}]` : ""}`.slice(0, 300);
  if (status === 401) return new ApiError("PROVIDER_UNAVAILABLE", `${context}: access denied (reconnect the Drive account).`);
  if (status === 404) return new ApiError("NOT_FOUND", safe);
  if (status === 403 || status === 429) {
    if (["userRateLimitExceeded", "rateLimitExceeded", "dailyLimitExceeded"].includes(reason)) {
      return new ApiError("PROVIDER_ERROR", safe, { status: 429 });
    }
    if (["quotaExceeded", "storageQuotaExceeded", "teamDriveFileLimitExceeded"].includes(reason)) {
      return new ApiError("PROVIDER_ERROR", safe, { status: 507 });
    }
    return new ApiError("PROVIDER_ERROR", safe);
  }
  return new ApiError("PROVIDER_ERROR", safe);
}

export class GoogleDriveProvider implements StorageProvider {
  constructor(
    private readonly opts: {
      accountId: string;
      getAccessToken: () => Promise<string>;
    }
  ) {}

  private async driveFetch(path: string, init: RequestInit & { context: string }): Promise<Response> {
    const token = await this.opts.getAccessToken();
    const { context, ...rest } = init;
    const res = await fetch(path.startsWith("http") ? path : `${DRIVE_API}${path}`, {
      ...rest,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(rest.headers ?? {}),
      },
    });
    if (!res.ok) {
      let body: GoogleErrorBody = {};
      try {
        body = (await res.json()) as GoogleErrorBody;
      } catch {
        /* ignore */
      }
      const err = mapGoogleError(res.status, body, context);
      logger.warn("drive.operation_failed", {
        accountId: this.opts.accountId,
        context,
        status: res.status,
        reason: body.error?.errors?.[0]?.reason,
      });
      throw err;
    }
    return res;
  }

  async getIdentity(): Promise<{ email: string | null; displayName: string | null }> {
    const res = await this.driveFetch("/about?fields=user(emailAddress,displayName)", {
      context: "drive.about",
    });
    const data = (await res.json()) as { user?: { emailAddress?: string; displayName?: string } };
    return {
      email: data.user?.emailAddress ?? null,
      displayName: data.user?.displayName ?? null,
    };
  }

  async ensureManagedFolder(): Promise<{ id: string }> {
    return this.ensureFolder(MANAGED_FOLDER_NAME);
  }

  async ensureFolder(name: string, parentId?: string): Promise<{ id: string }> {
    const parentQuery = parentId ? ` and '${parentId}' in parents` : "";
    const q = encodeURIComponent(
      `name='${name.replace(/'/g, "\'")}' and mimeType='${FOLDER_MIME}' and trashed=false` + parentQuery
    );
    const res = await this.driveFetch(`/files?q=${q}&fields=files(id,name)&pageSize=1`, {
      context: "drive.folder.list",
    });
    const data = (await res.json()) as { files?: Array<{ id: string }> };
    if (data.files && data.files.length > 0) {
      return { id: data.files[0].id };
    }
    const createRes = await this.driveFetch("/files", {
      method: "POST",
      context: "drive.folder.create",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        mimeType: FOLDER_MIME,
        parents: parentId ? [parentId] : undefined
      }),
    });
    const created = (await createRes.json()) as { id: string };
    return { id: created.id };
  }


  async createResumableUpload(input: {
    name: string;
    mimeType: string;
    sizeBytes: number;
    parentId: string;
  }): Promise<ResumableUploadSession> {
    const res = await this.driveFetch(`${DRIVE_UPLOAD_API}/files?uploadType=resumable`, {
      method: "POST",
      context: "drive.resumable.create",
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": input.mimeType,
        "X-Upload-Content-Length": String(input.sizeBytes),
      },
      body: JSON.stringify({
        name: input.name,
        mimeType: input.mimeType,
        parents: [input.parentId],
        // Keep the object private to the app/user — never "anyone with link".
        visibility: "PRIVATE",
      }),
    });
    const uploadUrl = res.headers.get("location");
    if (!uploadUrl) {
      throw new ApiError("PROVIDER_ERROR", "Google Drive did not return a resumable upload session.");
    }
    return {
      uploadUrl,
      expiresAt: Date.now() + 55 * 60 * 1000, // short-lived by policy (< ticket TTL)
      method: "PUT",
      headers: {
        "Content-Type": input.mimeType,
        "X-Upload-Content-Length": String(input.sizeBytes),
      },
    };
  }

  async getFileMeta(providerFileId: string): Promise<ProviderFileMeta | null> {
    try {
      const res = await this.driveFetch(
        `/files/${encodeURIComponent(providerFileId)}?fields=id,name,mimeType,size,parents,createdTime,trashed`,
        { context: "drive.file.get" }
      );
      const d = (await res.json()) as {
        id: string;
        name: string;
        mimeType: string;
        size?: string;
        parents?: string[];
        createdTime?: string;
        trashed?: boolean;
      };
      return {
        id: d.id,
        name: d.name,
        mimeType: d.mimeType,
        sizeBytes: Number(d.size ?? 0),
        parents: d.parents ?? [],
        createdTime: d.createdTime ? Date.parse(d.createdTime) : null,
        trashed: Boolean(d.trashed),
      };
    } catch (e) {
      if (e instanceof ApiError && e.code === "NOT_FOUND") return null;
      throw e;
    }
  }

  async deleteFile(providerFileId: string): Promise<{ deleted: boolean }> {
    try {
      await this.driveFetch(`/files/${encodeURIComponent(providerFileId)}`, {
        method: "DELETE",
        context: "drive.file.delete",
      });
      return { deleted: true };
    } catch (e) {
      if (e instanceof ApiError && e.code === "NOT_FOUND") {
        // Already gone — deletion is idempotent.
        return { deleted: true };
      }
      throw e;
    }
  }

  async download(providerFileId: string, range?: { start: number; end?: number }): Promise<DownloadHandle> {
    const token = await this.opts.getAccessToken();
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (range) {
      headers.Range = `bytes=${range.start}-${range.end ?? ""}`;
    }
    const res = await fetch(`${DRIVE_API}/files/${encodeURIComponent(providerFileId)}?alt=media`, { headers });
    if (!res.ok && res.status !== 206) {
      let body: GoogleErrorBody = {};
      try {
        body = (await res.json()) as GoogleErrorBody;
      } catch {
        /* ignore */
      }
      throw mapGoogleError(res.status, body, "drive.download");
    }
    if (!res.body) {
      throw new ApiError("PROVIDER_ERROR", "Drive download returned an empty body.");
    }
    const meta = await this.getFileMeta(providerFileId);
    return {
      stream: Readable.fromWeb(res.body as unknown as import("node:stream/web").ReadableStream),
      contentType: res.headers.get("content-type") ?? meta?.mimeType ?? "application/octet-stream",
      contentLength: res.headers.get("content-length") ? Number(res.headers.get("content-length")) : (meta?.sizeBytes ?? null),
      fileName: meta?.name ?? "download",
      status: res.status,
    };
  }

  async getQuota(): Promise<ProviderQuota | null> {
    try {
      const res = await this.driveFetch("/about?fields=storageQuota", { context: "drive.about.quota" });
      const data = (await res.json()) as {
        storageQuota?: { limit?: string; usage?: string; usageInDrive?: string };
      };
      const q = data.storageQuota;
      if (!q || (q.limit === undefined && q.usage === undefined)) return null;
      return {
        limitBytes: q.limit !== undefined ? Number(q.limit) : null,
        usageBytes: q.usage !== undefined ? Number(q.usage) : null,
        usageInDriveBytes: q.usageInDrive !== undefined ? Number(q.usageInDrive) : null,
      };
    } catch {
      // Capacity is only displayed when reliably reported.
      return null;
    }
  }

  async testOperation(parentId: string): Promise<void> {
    const createRes = await this.driveFetch("/files", {
      method: "POST",
      context: "drive.test.create",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: `kotha-bolbo-connectivity-test-${Date.now()}.txt`,
        mimeType: "text/plain",
        parents: [parentId],
      }),
    });
    const created = (await createRes.json()) as { id: string };
    await this.deleteFile(created.id);
  }
}
