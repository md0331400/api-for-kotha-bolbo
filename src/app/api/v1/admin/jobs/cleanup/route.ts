import { apiRoute, dataResponse } from "@/lib/api/handler";
import { runCleanup } from "@/lib/services/cleanup";
import { safeISOString, safeISOStringNullable } from "@/lib/safe-date";
import { logger } from "@/lib/logger";

/**
 * GET /api/v1/admin/jobs/cleanup
 * Cleanup job status: recent runs, errors, and retry queue depth.
 */
export const GET = apiRoute(
  async (ctx) => {
    const store = ctx.store!;
    const [runs, pendingRetries] = await Promise.all([store.listCleanupRuns(20), store.countPendingRetries()]);
    return dataResponse({
      runs: runs
        .filter((r) => r && typeof r.id === "string")
        .map((r) => ({
          id: r.id,
          startedAt: safeISOString((r as unknown as Record<string, unknown>).startedAt),
          finishedAt: safeISOStringNullable((r as unknown as Record<string, unknown>).finishedAt),
          status: typeof r.status === "string" ? r.status : "unknown",
          scanned: typeof r.scanned === "number" ? r.scanned : 0,
          deleted: typeof r.deleted === "number" ? r.deleted : 0,
          reservationReleased: typeof r.reservationReleased === "number" ? r.reservationReleased : 0,
          notified: typeof r.notified === "number" ? r.notified : 0,
          failed: typeof r.failed === "number" ? r.failed : 0,
          errors: Array.isArray(r.errors) ? r.errors.slice(0, 10) : [],
          triggeredBy: typeof r.triggeredBy === "string" ? r.triggeredBy : "unknown",
        })),
      pendingRetries: typeof pendingRetries === "number" ? pendingRetries : 0,
    });
  },
  { auth: "admin", rateLimit: { limit: 240, windowSec: 60, bucket: "admin" } }
);

/**
 * POST /api/v1/admin/jobs/cleanup
 * Trigger a cleanup run immediately (same code path as the cron job).
 */
export const POST = apiRoute(
  async (ctx) => {
    const { run } = await runCleanup(ctx.store!, ctx.config!, {
      triggeredBy: `admin:${ctx.auth!.uid}`,
    });
    try {
      await ctx.store!.appendAudit({
        actorUid: ctx.auth!.uid,
        actorEmail: ctx.auth!.email,
        action: "cleanup.trigger",
        targetType: "job",
        targetId: run.id,
        requestId: ctx.requestId,
        details: { status: run.status, deleted: run.deleted, failed: run.failed },
      });
    } catch (e) {
      logger.warn("cleanup.audit_failed", { requestId: ctx.requestId, error: e instanceof Error ? e.message : String(e) });
    }
    return dataResponse(run);
  },
  { auth: "admin", rateLimit: { limit: 12, windowSec: 60, bucket: "cleanup" } }
);
