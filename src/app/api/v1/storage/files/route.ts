import { apiRoute, paginatedResponse, ensureUser } from "@/lib/api/handler";
import { parseOrThrow, fileListQuerySchema } from "@/lib/validation";
import { toPublicFile } from "@/lib/db/types";
import { pageMeta } from "@/lib/format";

/**
 * GET /api/v1/storage/files
 * Paginated list of the authenticated user's files only. Supports filters for
 * category, status, creation window, and upcoming expiry.
 */
export const GET = apiRoute(
  async (ctx) => {
    const user = await ensureUser(ctx);
    const q = parseOrThrow(fileListQuerySchema, Object.fromEntries(ctx.req.nextUrl.searchParams));
    const offset = (q.page - 1) * q.pageSize;
    const result = await ctx.store!.listFiles(
      {
        uid: user.uid,
        category: q.category,
        status: q.status ?? "confirmed",
        expiringInDays: q.expiringInDays,
        createdAfter: q.createdAfter,
        createdBefore: q.createdBefore,
        q: q.q,
        sort: q.sort,
        order: q.order,
      },
      { page: q.page, pageSize: q.pageSize, offset }
    );
    return paginatedResponse(
      result.items.map((f) => toPublicFile(f)),
      pageMeta(q.page, q.pageSize, result.total)
    );
  },
  { auth: "user", scope: "storage:read", rateLimit: { limit: 120, windowSec: 60, bucket: "files" } }
);
