import { apiRoute, dataResponse } from "@/lib/api/handler";
import type { DriveAccountRecord } from "@/lib/db/types";
import { safeISOString, safeISOStringNullable } from "@/lib/safe-date";
import { logger } from "@/lib/logger";

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
      let tokenReadFailed = false;
      try {
        token = await store.getDriveToken(a.id);
      } catch (e) {
        tokenReadFailed = true;
        token = null;
        logger.warn("drive.list.token_read_failed", {
          requestId: ctx.requestId,
          accountId: a.id,
          error: e instanceof Error ? e.message : String(e),
        });
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
        // When token read fails we cannot prove presence/absence — report false
        // but observability is preserved via the warning above. Never leak token.
        hasStoredCredentials: tokenReadFailed ? false : Boolean(token),
        hasGoogleAccountId: Boolean(a.googleAccountId),
        disabledReason: typeof a.disabledReason === "string" ? a.disabledReason : null,
      });
    }
    return dataResponse(shaped);
  },
  { auth: "admin", rateLimit: { limit: 240, windowSec: 60, bucket: "admin" } }
);
