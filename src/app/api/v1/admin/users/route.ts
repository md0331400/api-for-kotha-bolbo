import { apiRoute, paginatedResponse } from "@/lib/api/handler";
import { parseOrThrow, adminUserListQuerySchema } from "@/lib/validation";
import { pageMeta } from "@/lib/format";

function publicUser(u: {
  uid: string;
  email: string | null;
  displayName: string | null;
  quotaBytes: number;
  usedBytes: number;
  reservedBytes: number;
  fileCount: number;
  restricted: boolean;
  createdAt: number;
  lastLoginAt: number;
}) {
  return {
    uid: u.uid,
    email: u.email,
    displayName: u.displayName,
    quotaBytes: u.quotaBytes,
    usedBytes: u.usedBytes,
    reservedBytes: u.reservedBytes,
    remainingBytes: Math.max(0, u.quotaBytes - u.usedBytes - u.reservedBytes),
    fileCount: u.fileCount,
    restricted: u.restricted,
    createdAt: new Date(u.createdAt).toISOString(),
    lastLoginAt: new Date(u.lastLoginAt).toISOString(),
  };
}

/**
 * GET /api/v1/admin/users
 * Search/list users by UID, email, or display name (records that exist in the
 * database — no fabricated accounts). Passwords are never stored or shown.
 */
export const GET = apiRoute(
  async (ctx) => {
    const q = parseOrThrow(adminUserListQuerySchema, Object.fromEntries(ctx.req.nextUrl.searchParams));
    const result = await ctx.store!.listUsers(q.q, {
      page: q.page,
      pageSize: q.pageSize,
      offset: (q.page - 1) * q.pageSize,
    });
    return paginatedResponse(result.items.map(publicUser), pageMeta(q.page, q.pageSize, result.total));
  },
  { auth: "admin", rateLimit: { limit: 240, windowSec: 60, bucket: "admin" } }
);
