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
    // Token deletion is authoritative — if it fails, do NOT mark the
    // account as disconnected. Reporting \"disconnected\" while credentials
    // remain would be a false success and leave the account usable.
    // Only proceed to status update after token is confirmed deleted.
    const preToken = await store.getDriveToken(id).catch(() => null);
    try {
      await store.deleteDriveToken(id);
    } catch (e) {
      logger.error("drive.disconnect.token_delete_failed", {
        requestId: ctx.requestId,
        accountId: id,
        error: e instanceof Error ? e.message : String(e),
        hasToken: Boolean(preToken),
      });
      throw new ApiError("INTERNAL", "Could not destroy stored credentials. The account is still connected — retry the disconnect.", { cause: e });
    }
    // Verify deletion when a token existed — if the provider still returns a
    // token after delete, the operation did not take effect.
    if (preToken) {
      try {
        const after = await store.getDriveToken(id);
        if (after) {
          logger.error("drive.disconnect.token_still_present", { requestId: ctx.requestId, accountId: id });
          throw new ApiError("INTERNAL", "Stored credentials still present after delete. Retry the disconnect.");
        }
      } catch (e) {
        if (e instanceof ApiError) throw e;
        // Verification read failure is non-fatal — we already deleted, status
        // update will be the source of truth.
        logger.warn("drive.disconnect.token_verify_failed", { requestId: ctx.requestId, accountId: id, error: e instanceof Error ? e.message : String(e) });
      }
    }
    clearTokenCache(id);
    const updated = await store.updateDriveAccount(id, {
      status: "disconnected",
      disabledReason: "Disconnected by administrator.",
      verified: false,
    });
    if (!updated) {
      logger.error("drive.disconnect.update_failed", { requestId: ctx.requestId, accountId: id });
      throw new ApiError("INTERNAL", "Could not update drive account status. Retry the disconnect.");
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
