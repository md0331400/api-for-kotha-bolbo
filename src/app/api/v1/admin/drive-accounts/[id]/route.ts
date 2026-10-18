import { apiRoute, dataResponse } from "@/lib/api/handler";
import { ApiError } from "@/lib/errors";
import { parseOrThrow, drivePatchSchema } from "@/lib/validation";
import { clearTokenCache, recordAccountSuccess } from "@/lib/storage/pool";

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

    await store.appendAudit({
      actorUid: ctx.auth!.uid,
      actorEmail: ctx.auth!.email,
      action: `drive.${body.action}`,
      targetType: "drive_account",
      targetId: id,
      requestId: ctx.requestId,
      details: { reason: body.reason ?? null },
    });
    const updated = await store.getDriveAccount(id);
    return dataResponse({ id, status: updated!.status, verified: updated!.verified, lastErrorMessage: updated!.lastErrorMessage });
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
    await store.deleteDriveToken(id);
    clearTokenCache(id);
    await store.updateDriveAccount(id, {
      status: "disconnected",
      disabledReason: "Disconnected by administrator.",
      verified: false,
    });
    await store.appendAudit({
      actorUid: ctx.auth!.uid,
      actorEmail: ctx.auth!.email,
      action: "drive.disconnect",
      targetType: "drive_account",
      targetId: id,
      requestId: ctx.requestId,
      details: { fileCount: account.fileCount, accountEmail: account.accountEmail },
    });
    return dataResponse({ id, status: "disconnected" });
  },
  { auth: "admin", rateLimit: { limit: 240, windowSec: 60, bucket: "admin" } }
);
