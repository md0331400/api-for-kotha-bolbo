import { apiRoute, dataResponse } from "@/lib/api/handler";
import { ApiError } from "@/lib/errors";
import { parseOrThrow, drivePatchSchema } from "@/lib/validation";
import { clearTokenCache, recordAccountSuccess } from "@/lib/storage/pool";
import { logger } from "@/lib/logger";

async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

/**
 * PATCH /api/v1/admin/drive-accounts/:id
 * Enable, disable, or retry a storage account.
 */
export const PATCH = apiRoute(
  async (ctx) => {
    const id = ctx.params.id;
    const store = ctx.store!;
    const body = parseOrThrow(drivePatchSchema, await readJson(ctx.req));
    const account = await store.getDriveAccount(id);
    if (!account) throw new ApiError("NOT_FOUND", "Drive account not found.");

    if (body.action === "enable") {
      await store.updateDriveAccount(id, { status: "enabled", disabledReason: null, lastErrorMessage: null });
    } else if (body.action === "disable") {
      await store.updateDriveAccount(id, {
        status: "disabled",
        disabledReason: body.reason ?? "Disabled by administrator.",
      });
    } else if (body.action === "retry") {
      // Clear cooldown and re-test connectivity with a real operation.
      clearTokenCache(id);
      const { getDriveProvider } = await import("@/lib/storage/pool");
      try {
        const provider = await getDriveProvider(store, ctx.config!, id);
        const folderId = account.managedFolderId ?? (await provider.ensureManagedFolder()).id;
        if (!account.managedFolderId) await store.updateDriveAccount(id, { managedFolderId: folderId });
        await provider.testOperation(folderId);
        await store.updateDriveAccount(id, {
          status: "enabled",
          disabledReason: null,
          lastErrorMessage: null,
          verified: true,
          lastSuccessAt: Date.now(),
          lastErrorAt: null,
        });
        await recordAccountSuccess(store, id);
      } catch (e) {
        const message = e instanceof Error ? e.message : "retry failed";
        await store.updateDriveAccount(id, {
          lastErrorAt: Date.now(),
          lastErrorMessage: message.slice(0, 500),
          status: "error",
        });
        throw new ApiError("PROVIDER_ERROR", `Connectivity test failed: ${message.slice(0, 200)}`);
      }
    }

    try {
      await store.appendAudit({
        actorUid: ctx.auth!.uid,
        actorEmail: ctx.auth!.email,
        action: `drive.${body.action}`,
        targetType: "drive_account",
        targetId: id,
        requestId: ctx.requestId,
        details: { reason: body.reason ?? null },
      });
    } catch (e) {
      logger.warn("drive.patch.audit_failed", { requestId: ctx.requestId, accountId: id, error: e instanceof Error ? e.message : String(e) });
    }
    const updated = await store.getDriveAccount(id);
    if (!updated) throw new ApiError("NOT_FOUND", "Drive account not found after update.");
    return dataResponse({ id, status: updated.status, verified: updated.verified, lastErrorMessage: updated.lastErrorMessage });
  },
  { auth: "admin", rateLimit: { limit: 240, windowSec: 60, bucket: "admin" } }
);

/**
 * DELETE /api/v1/admin/drive-accounts/:id
 * Disconnects an account and destroys its stored credentials. Stored file
 * records are kept; files on the account become inaccessible for download
 * until the account is reconnected (documented in the UI confirmation).
 */
export const DELETE = apiRoute(
  async (ctx) => {
    const id = ctx.params.id;
    const store = ctx.store!;
    const account = await store.getDriveAccount(id);
    if (!account) throw new ApiError("NOT_FOUND", "Drive account not found.");
    const confirm = ctx.req.nextUrl.searchParams.get("confirm");
    if (confirm !== account.id && confirm !== "DISCONNECT") {
      throw new ApiError("BAD_REQUEST", "Disconnect requires ?confirm=<account id> or ?confirm=DISCONNECT.");
    }
    // Token deletion is authoritative — do NOT treat read failure as \"no token\".
    // A read failure leaves state unknown; we must not skip verification.
    let preToken: unknown = null;
    let preTokenReadFailed = false;
    try {
      preToken = await store.getDriveToken(id);
    } catch (e) {
      preTokenReadFailed = true;
      logger.warn("drive.disconnect.token_read_failed", {
        requestId: ctx.requestId,
        accountId: id,
        error: e instanceof Error ? e.message : String(e),
      });
      // Unknown whether token existed — treat as \"maybe\" so verification is not skipped.
      preToken = undefined;
    }
    try {
      await store.deleteDriveToken(id);
    } catch (e) {
      logger.error("drive.disconnect.token_delete_failed", {
        requestId: ctx.requestId,
        accountId: id,
        error: e instanceof Error ? e.message : String(e),
        preReadFailed: preTokenReadFailed,
        hadToken: preToken !== null,
      });
      throw new ApiError("INTERNAL", "Could not destroy stored credentials. The account is still connected — retry the disconnect.", { cause: e });
    }
    // Verify deletion. If preToken was null (definitely no token) we can skip,
    // but if it was undefined (read failed) or an object (had token), we must
    // confirm the store is now empty. A read failure during verification
    // when preTokenReadFailed is true means we cannot prove deletion — fail safe.
    const hadTokenOrUnknown = preToken !== null;
    if (hadTokenOrUnknown) {
      try {
        const after = await store.getDriveToken(id);
        if (after) {
          logger.error("drive.disconnect.token_still_present", { requestId: ctx.requestId, accountId: id });
          throw new ApiError("INTERNAL", "Stored credentials still present after delete. Retry the disconnect.");
        }
      } catch (e) {
        if (e instanceof ApiError) throw e;
        if (preTokenReadFailed) {
          // We never confirmed pre-state and now cannot confirm post-state — safest is to report failure
          logger.error("drive.disconnect.token_verify_failed_after_read_failed", {
            requestId: ctx.requestId,
            accountId: id,
            error: e instanceof Error ? e.message : String(e),
          });
          throw new ApiError("INTERNAL", "Could not verify credential destruction after a read failure. Retry the disconnect and check logs.", { cause: e });
        }
        logger.warn("drive.disconnect.token_verify_failed", { requestId: ctx.requestId, accountId: id, error: e instanceof Error ? e.message : String(e) });
      }
    }
    clearTokenCache(id);
    const updated = await store.updateDriveAccount(id, {
      status: "disconnected",
      disabledReason: "Disconnected by administrator.",
      verified: false,
    });
    if (!updated || updated.status !== "disconnected") {
      logger.error("drive.disconnect.update_failed_partial", {
        requestId: ctx.requestId,
        accountId: id,
        updatedStatus: updated?.status ?? null,
        // Token was already destroyed at this point — account is in partial state
        // (credentials gone but status not yet disconnected). Retry is safe and
        // idempotent and will complete the status transition.
        tokenAlreadyDestroyed: true,
      });
      throw new ApiError("INTERNAL", "Stored credentials were destroyed but the account status could not be updated. Retry the disconnect to complete it.", { cause: undefined });
    }
    try {
      await store.appendAudit({
        actorUid: ctx.auth!.uid,
        actorEmail: ctx.auth!.email,
        action: "drive.disconnect",
        targetType: "drive_account",
        targetId: id,
        requestId: ctx.requestId,
        details: {
          fileCount: typeof account.fileCount === "number" ? account.fileCount : 0,
          accountEmail: account.accountEmail ?? null,
        },
      });
    } catch (e) {
      logger.warn("drive.disconnect.audit_failed", {
        requestId: ctx.requestId,
        accountId: id,
        error: e instanceof Error ? e.message : String(e),
      });
      // Audit is secondary — credentials are already destroyed and status is
      // disconnected. Do not roll back, but the warning is observable and the
      // operation is idempotent so a retry will attempt audit again.
    }
    return dataResponse({ id, status: "disconnected" });
  },
  { auth: "admin", rateLimit: { limit: 240, windowSec: 60, bucket: "admin" } }
);
