import { apiRoute, dataResponse } from "@/lib/api/handler";
import { ApiError } from "@/lib/errors";
import { deleteFileFully } from "@/lib/services/cleanup";

/**
 * DELETE /api/v1/admin/files/:id
 * Administrator file deletion with explicit confirmation. Audited.
 */
export const DELETE = apiRoute(
  async (ctx) => {
    const fileId = ctx.params.id;
    const store = ctx.store!;
    const file = await store.getFile(fileId);
    if (!file) throw new ApiError("NOT_FOUND", "File not found.");
    const confirm = ctx.req.nextUrl.searchParams.get("confirm");
    if (confirm !== "1" && confirm !== "DELETE") {
      throw new ApiError("BAD_REQUEST", "Deleting a file requires ?confirm=1.");
    }
    if (file.status === "deleted") {
      return dataResponse({ id: file.id, status: "deleted", alreadyDeleted: true });
    }
    const res = await deleteFileFully(store, ctx.config!, file, {
      actor: `admin:${ctx.auth!.uid}`,
      adminUid: ctx.auth!.uid,
    });
    if (!res.ok) {
      throw new ApiError("PROVIDER_ERROR", `File deletion did not complete: ${res.error ?? "unknown error"}`, {
        details: { fileId: file.id, willRetry: true },
      });
    }
    await store.appendAudit({
      actorUid: ctx.auth!.uid,
      actorEmail: ctx.auth!.email,
      action: "file.delete.admin",
      targetType: "file",
      targetId: file.id,
      requestId: ctx.requestId,
      details: { uid: file.uid, sizeBytes: file.sizeBytes, category: file.category },
    });
    return dataResponse({ id: file.id, status: "deleted", alreadyDeleted: Boolean(res.alreadyGone) });
  },
  { auth: "admin", rateLimit: { limit: 240, windowSec: 60, bucket: "admin" } }
);
