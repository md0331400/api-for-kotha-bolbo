import { apiRoute, dataResponse } from "@/lib/api/handler";
import { ApiError } from "@/lib/errors";
import { getDriveProvider, recordAccountError, recordAccountSuccess } from "@/lib/storage/pool";

/**
 * POST /api/v1/admin/drive-accounts/:id/test
 * Runs a real create+delete operation against the connected account and
 * refreshes its quota information (only shown when the provider reports it).
 */
export const POST = apiRoute(
  async (ctx) => {
    const id = ctx.params.id;
    const store = ctx.store!;
    const account = await store.getDriveAccount(id);
    if (!account) throw new ApiError("NOT_FOUND", "Drive account not found.");
    if (account.status === "disconnected") {
      throw new ApiError("CONFLICT", "Account is disconnected. Reconnect it first.");
    }
    try {
      const provider = await getDriveProvider(store, ctx.config!, id);
      const folderId = account.managedFolderId ?? (await provider.ensureManagedFolder()).id;
      if (!account.managedFolderId) await store.updateDriveAccount(id, { managedFolderId: folderId });
      await provider.testOperation(folderId);
      const quota = await provider.getQuota();
      await store.updateDriveAccount(id, {
        quotaInfo: quota
          ? {
              limitBytes: quota.limitBytes,
              usageBytes: quota.usageBytes,
              usageInDriveBytes: quota.usageInDriveBytes,
              fetchedAt: Date.now(),
            }
          : null,
      });
      await recordAccountSuccess(store, id);
      await store.appendAudit({
        actorUid: ctx.auth!.uid,
        actorEmail: ctx.auth!.email,
        action: "drive.test",
        targetType: "drive_account",
        targetId: id,
        requestId: ctx.requestId,
        details: { ok: true },
      });
      return dataResponse({ ok: true, quotaInfo: quota });
    } catch (e) {
      const message = e instanceof Error ? e.message : "test failed";
      await recordAccountError(store, id, message);
      await store.appendAudit({
        actorUid: ctx.auth!.uid,
        actorEmail: ctx.auth!.email,
        action: "drive.test",
        targetType: "drive_account",
        targetId: id,
        requestId: ctx.requestId,
        details: { ok: false, error: message.slice(0, 200) },
      });
      throw new ApiError("PROVIDER_ERROR", `Connectivity test failed: ${message.slice(0, 200)}`);
    }
  },
  { auth: "admin", rateLimit: { limit: 30, windowSec: 60, bucket: "admin" } }
);
