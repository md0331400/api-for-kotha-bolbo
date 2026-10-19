import { apiRoute, dataResponse } from "@/lib/api/handler";
import type { DriveAccountRecord } from "@/lib/db/types";
import { safeISOString, safeISOStringNullable } from "@/lib/safe-date";

export type PublicDriveAccount = Omit<DriveAccountRecord, never> & { hasStoredCredentials: boolean };

/**
 * GET /api/v1/admin/drive-accounts
 * Lists storage-pool accounts with connection status, last operation, and
 * assigned file count. Tokens/credentials are never included.
 */
export const GET = apiRoute(
  async (ctx) => {
    const store = ctx.store!;
    const accounts = await store.listDriveAccounts();
    const shaped = [];
    for (const a of accounts) {
      if (!a || typeof a.id !== "string") continue;
      let token = null;
      try {
        token = await store.getDriveToken(a.id);
      } catch {
        token = null;
      }
      shaped.push({
        id: a.id,
        accountEmail: a.accountEmail ?? null,
        displayName: a.displayName ?? null,
        status: typeof a.status === "string" ? a.status : "error",
        verified: Boolean(a.verified),
        connectedAt: safeISOString((a as unknown as Record<string, unknown>).connectedAt),
        updatedAt: safeISOString((a as unknown as Record<string, unknown>).updatedAt),
        lastSuccessAt: safeISOStringNullable((a as unknown as Record<string, unknown>).lastSuccessAt),
        lastErrorAt: safeISOStringNullable((a as unknown as Record<string, unknown>).lastErrorAt),
        lastErrorMessage: typeof a.lastErrorMessage === "string" ? a.lastErrorMessage : null,
        fileCount: typeof a.fileCount === "number" ? a.fileCount : 0,
        totalBytes: typeof a.totalBytes === "number" ? a.totalBytes : 0,
        quotaInfo: a.quotaInfo ?? null,
        hasManagedFolder: Boolean(a.managedFolderId),
        hasStoredCredentials: Boolean(token),
        hasGoogleAccountId: Boolean(a.googleAccountId),
        disabledReason: typeof a.disabledReason === "string" ? a.disabledReason : null,
      });
    }
    return dataResponse(shaped);
  },
  { auth: "admin", rateLimit: { limit: 240, windowSec: 60, bucket: "admin" } }
);
