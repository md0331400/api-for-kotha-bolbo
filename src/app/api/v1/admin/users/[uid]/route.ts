import { apiRoute, dataResponse } from "@/lib/api/handler";
import { ApiError } from "@/lib/errors";
import { parseOrThrow, setUserQuotaSchema } from "@/lib/validation";
import { toPublicFile } from "@/lib/db/types";

/**
 * GET /api/v1/admin/users/:uid
 * User detail: usage, quota, file count, and expiry summary.
 */
export const GET = apiRoute(
  async (ctx) => {
    const uid = ctx.params.uid;
    const store = ctx.store!;
    const user = await store.getUser(uid);
    if (!user) throw new ApiError("NOT_FOUND", "User not found.");
    const snapshot = await store.getQuotaSnapshot(uid);
    const files = await store.listFiles({ uid, status: "confirmed" }, { page: 1, pageSize: 100, offset: 0 });
    const now = Date.now();
    const expiringSoon = files.items.filter((f) => f.expiresAt - now <= 7 * 86_400_000).map((f) => toPublicFile(f, now));
    return dataResponse({
      user: {
        uid: user.uid,
        email: user.email,
        displayName: user.displayName,
        quotaBytes: user.quotaBytes,
        usedBytes: user.usedBytes,
        reservedBytes: user.reservedBytes,
        remainingBytes: snapshot!.remainingBytes,
        fileCount: user.fileCount,
        restricted: user.restricted,
        createdAt: new Date(user.createdAt).toISOString(),
        lastLoginAt: new Date(user.lastLoginAt).toISOString(),
      },
      expiringSoon,
    });
  },
  { auth: "admin", rateLimit: { limit: 240, windowSec: 60, bucket: "admin" } }
);

/**
 * PATCH /api/v1/admin/users/:uid
 * Change quota or restrict storage access. Always audited.
 */
export const PATCH = apiRoute(
  async (ctx) => {
    const uid = ctx.params.uid;
    const store = ctx.store!;
    const body = parseOrThrow(setUserQuotaSchema, await (async () => {
      try {
        return await ctx.req.json();
      } catch {
        return {};
      }
    })());
    const before = await store.getUser(uid);
    if (!before) throw new ApiError("NOT_FOUND", "User not found.");
    const updated = await store.setUserFields(uid, body);
    await store.appendAudit({
      actorUid: ctx.auth!.uid,
      actorEmail: ctx.auth!.email,
      action: body.quotaBytes !== undefined ? "user.quota.change" : "user.restriction.change",
      targetType: "user",
      targetId: uid,
      requestId: ctx.requestId,
      details: {
        before: { quotaBytes: before.quotaBytes, restricted: before.restricted },
        after: { quotaBytes: updated!.quotaBytes, restricted: updated!.restricted },
      },
    });
    return dataResponse({
      uid,
      quotaBytes: updated!.quotaBytes,
      restricted: updated!.restricted,
    });
  },
  { auth: "admin", rateLimit: { limit: 240, windowSec: 60, bucket: "admin" } }
);
