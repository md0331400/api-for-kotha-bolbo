import { apiRoute, paginatedResponse } from "@/lib/api/handler";
import { parseOrThrow, adminFileListQuerySchema } from "@/lib/validation";
import { pageMeta } from "@/lib/format";
import { toPublicFile } from "@/lib/db/types";

/**
 * GET /api/v1/admin/files
 * Paginated list of all stored files with filters (user, category, status,
 * date, expiry). Real database records only.
 */
export const GET = apiRoute(
  async (ctx) => {
    const q = parseOrThrow(adminFileListQuerySchema, Object.fromEntries(ctx.req.nextUrl.searchParams));
    const result = await ctx.store!.listFiles(
      {
        uid: q.uid,
        category: q.category,
        status: q.status,
        expiringInDays: q.expiringInDays,
        createdAfter: q.createdAfter,
        createdBefore: q.createdBefore,
        q: q.q,
        sort: q.sort,
        order: q.order,
      },
      { page: q.page, pageSize: q.pageSize, offset: (q.page - 1) * q.pageSize }
    );
    return paginatedResponse(
      result.items.map((f) => ({
        ...toPublicFile(f),
        uid: f.uid,
        providerAccountId: f.providerAccountId,
        providerFileId: f.providerFileId,
        deleteAttempts: f.deleteAttempts ?? 0,
        lastDeleteError: f.lastDeleteError ?? null,
      })),
      pageMeta(q.page, q.pageSize, result.total)
    );
  },
  { auth: "admin", rateLimit: { limit: 240, windowSec: 60, bucket: "admin" } }
);
