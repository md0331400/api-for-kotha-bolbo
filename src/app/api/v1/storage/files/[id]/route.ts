import { apiRoute, dataResponse, ensureUser } from "@/lib/api/handler";
import { ApiError } from "@/lib/errors";
import { toPublicFile } from "@/lib/db/types";
import { deleteFileFully } from "@/lib/services/cleanup";

/**
 * GET /api/v1/storage/files/:id
 * File metadata. Owners and administrators only.
 */
export const GET = apiRoute(
  async (ctx) => {
    const fileId = ctx.params.id;
    const file = await ctx.store!.getFile(fileId);
    if (!file) throw new ApiError("NOT_FOUND", "File not found.");
    const auth = ctx.auth!;
    if (file.uid !== auth.uid && !auth.isAdmin) {
      throw new ApiError("FORBIDDEN", "This file belongs to another user.");
    }
    return dataResponse(toPublicFile(file));
  },
  { auth: "user", scope: "storage:read", rateLimit: { limit: 120, windowSec: 60, bucket: "file-meta" } }
);

/**
 * DELETE /api/v1/storage/files/:id
 * Deletes the provider object and finalizes quota. Idempotent: deleting an
 * already-deleted file succeeds. Owners and administrators only.
 */
export const DELETE = apiRoute(
  async (ctx) => {
    const fileId = ctx.params.id;
    const auth = ctx.auth!;
    const store = ctx.store!;
    const file = await store.getFile(fileId);
    if (!file) throw new ApiError("NOT_FOUND", "File not found.");
    if (file.uid !== auth.uid && !auth.isAdmin) {
      throw new ApiError("FORBIDDEN", "This file belongs to another user.");
    }
    if (file.status === "deleted") {
      return dataResponse({ id: file.id, status: "deleted", alreadyDeleted: true });
    }
    const res = await deleteFileFully(store, ctx.config!, file, {
      actor: auth.isAdmin ? `admin:${auth.uid}` : `user:${auth.uid}`,
      ...(auth.isAdmin ? { adminUid: auth.uid } : {}),
    });
    if (!res.ok) {
      throw new ApiError("PROVIDER_ERROR", `File deletion did not complete: ${res.error ?? "unknown error"}`, {
        details: { fileId: file.id, willRetry: true },
      });
    }
    await store.appendAudit({
      actorUid: auth.uid,
      actorEmail: auth.email,
      action: auth.isAdmin ? "file.delete.admin" : "file.delete.owner",
      targetType: "file",
      targetId: file.id,
      requestId: ctx.requestId,
      details: { sizeBytes: file.sizeBytes, providerAccountId: file.providerAccountId },
    });
    return dataResponse({ id: file.id, status: "deleted", alreadyDeleted: Boolean(res.alreadyGone) });
  },
  { auth: "user", scope: "storage:delete", rateLimit: { limit: 60, windowSec: 60, bucket: "file-delete" } }
);
