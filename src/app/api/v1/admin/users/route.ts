import { apiRoute, paginatedResponse } from "@/lib/api/handler";
import { parseOrThrow, adminUserListQuerySchema } from "@/lib/validation";
import { pageMeta } from "@/lib/format";
import { safeISOString } from "@/lib/safe-date";

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
}): Record<string, unknown> | null {
  if (!u || typeof u.uid !== "string") return null;
  return {
    uid: u.uid,
    email: u.email ?? null,
    displayName: u.displayName ?? null,
    quotaBytes: typeof u.quotaBytes === "number" ? u.quotaBytes : 0,
    usedBytes: typeof u.usedBytes === "number" ? u.usedBytes : 0,
    reservedBytes: typeof u.reservedBytes === "number" ? u.reservedBytes : 0,
    remainingBytes: Math.max(0, (typeof u.quotaBytes === "number" ? u.quotaBytes : 0) - (typeof u.usedBytes === "number" ? u.usedBytes : 0) - (typeof u.reservedBytes === "number" ? u.reservedBytes : 0)),
    fileCount: typeof u.fileCount === "number" ? u.fileCount : 0,
    restricted: Boolean(u.restricted),
    createdAt: safeISOString((u as unknown as Record<string, unknown>).createdAt),
    lastLoginAt: safeISOString((u as unknown as Record<string, unknown>).lastLoginAt),
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
    return paginatedResponse(result.items.map(publicUser).filter(Boolean), pageMeta(q.page, q.pageSize, result.total));
  },
  { auth: "admin", rateLimit: { limit: 240, windowSec: 60, bucket: "admin" } }
);
