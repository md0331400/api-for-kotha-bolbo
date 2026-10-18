import { apiRoute, dataResponse } from "@/lib/api/handler";
import type { DriveAccountRecord } from "@/lib/db/types";

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
      const token = await store.getDriveToken(a.id);
      shaped.push({
        id: a.id,
        accountEmail: a.accountEmail,
        displayName: a.displayName,
        status: a.status,
        verified: a.verified,
        connectedAt: new Date(a.connectedAt).toISOString(),
        updatedAt: new Date(a.updatedAt).toISOString(),
        lastSuccessAt: a.lastSuccessAt ? new Date(a.lastSuccessAt).toISOString() : null,
        lastErrorAt: a.lastErrorAt ? new Date(a.lastErrorAt).toISOString() : null,
        lastErrorMessage: a.lastErrorMessage,
        fileCount: a.fileCount,
        totalBytes: a.totalBytes,
        quotaInfo: a.quotaInfo,
        hasManagedFolder: Boolean(a.managedFolderId),
        hasStoredCredentials: Boolean(token),
        disabledReason: a.disabledReason,
      });
    }
    return dataResponse(shaped);
  },
  { auth: "admin", rateLimit: { limit: 240, windowSec: 60, bucket: "admin" } }
);
