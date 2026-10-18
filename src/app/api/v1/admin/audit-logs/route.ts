import { apiRoute, paginatedResponse } from "@/lib/api/handler";
import { z } from "zod";
import { parseOrThrow } from "@/lib/validation";
import { pageMeta } from "@/lib/format";

const querySchema = z.object({
  action: z.string().max(64).optional(),
  actorUid: z.string().max(128).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

/**
 * GET /api/v1/admin/audit-logs
 * Administrator action history (no secrets, tokens, or file contents logged).
 */
export const GET = apiRoute(
  async (ctx) => {
    const q = parseOrThrow(querySchema, Object.fromEntries(ctx.req.nextUrl.searchParams));
    const result = await ctx.store!.listAuditLogs(
      { action: q.action, actorUid: q.actorUid },
      { page: q.page, pageSize: q.pageSize, offset: (q.page - 1) * q.pageSize }
    );
    return paginatedResponse(
      result.items.map((l) => ({
        id: l.id,
        at: new Date(l.at || Date.now()).toISOString(),
        actorUid: l.actorUid,
        actorEmail: l.actorEmail,
        action: l.action,
        targetType: l.targetType,
        targetId: l.targetId,
        requestId: l.requestId,
        details: l.details,
      })),
      pageMeta(q.page, q.pageSize, result.total)
    );
  },
  { auth: "admin", rateLimit: { limit: 240, windowSec: 60, bucket: "admin" } }
);
