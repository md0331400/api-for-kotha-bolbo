import { apiRoute, dataResponse, ensureUser } from "@/lib/api/handler";

/**
 * GET /api/v1/storage/quota
 * Authenticated user's quota and usage. Usage always reflects confirmed file
 * records and active reservations (0 B when nothing has been uploaded).
 */
export const GET = apiRoute(
  async (ctx) => {
    const user = await ensureUser(ctx);
    const snapshot = await ctx.store!.getQuotaSnapshot(user.uid);
    const files = await ctx.store!.listFiles(
      { uid: user.uid, status: "confirmed" },
      { page: 1, pageSize: 1000, offset: 0 }
    );
    const categories: Record<string, number> = { chat: 0, voice: 0, photo: 0, video: 0, other: 0 };
    const categoryBytes: Record<string, number> = { chat: 0, voice: 0, photo: 0, video: 0, other: 0 };
    for (const f of files.items) {
      categories[f.category] += 1;
      categoryBytes[f.category] += f.sizeBytes;
    }
    return dataResponse({
      quotaBytes: snapshot!.quotaBytes,
      usedBytes: snapshot!.usedBytes,
      reservedBytes: snapshot!.reservedBytes,
      remainingBytes: snapshot!.remainingBytes,
      fileCount: snapshot!.fileCount,
      restricted: snapshot!.restricted,
      categories,
      categoryBytes,
    });
  },
  { auth: "user", scope: "storage:read", rateLimit: { limit: 60, windowSec: 60, bucket: "quota" } }
);
