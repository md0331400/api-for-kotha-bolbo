import { apiRoute, dataResponse } from "@/lib/api/handler";
import { ApiError } from "@/lib/errors";

/**
 * DELETE /api/v1/admin/users/:uid/files
 * Queues deletion of a user's stored files (processed by the cleanup job).
 * Requires explicit confirmation (?confirm=DELETE) — never accidental.
 */
export const DELETE = apiRoute(
  async (ctx) => {
    const uid = ctx.params.uid;
    const store = ctx.store!;
    const user = await store.getUser(uid);
    if (!user) throw new ApiError("NOT_FOUND", "User not found.");
    const confirm = ctx.req.nextUrl.searchParams.get("confirm");
    if (confirm !== "DELETE") {
      throw new ApiError("BAD_REQUEST", "Purging a user's files requires ?confirm=DELETE.");
    }
    const queued = await store.purgeUserFiles(uid, 500);
    await store.appendAudit({
      actorUid: ctx.auth!.uid,
      actorEmail: ctx.auth!.email,
      action: "user.files.purge",
      targetType: "user",
      targetId: uid,
      requestId: ctx.requestId,
      details: { queued },
    });
    return dataResponse({ uid, queuedForDeletion: queued, note: "Deletion proceeds via the cleanup job." });
  },
  { auth: "admin", rateLimit: { limit: 30, windowSec: 60, bucket: "admin" } }
);
