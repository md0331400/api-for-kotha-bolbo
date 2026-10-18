import { apiRoute, dataResponse } from "@/lib/api/handler";
import { runCleanup } from "@/lib/services/cleanup";

/**
 * GET /api/v1/admin/jobs/cleanup
 * Cleanup job status: recent runs, errors, and retry queue depth.
 */
export const GET = apiRoute(
  async (ctx) => {
    const store = ctx.store!;
    const [runs, pendingRetries] = await Promise.all([store.listCleanupRuns(20), store.countPendingRetries()]);
    return dataResponse({
      runs: runs.map((r) => ({
        id: r.id,
        startedAt: new Date(r.startedAt).toISOString(),
        finishedAt: r.finishedAt ? new Date(r.finishedAt).toISOString() : null,
        status: r.status,
        scanned: r.scanned,
        deleted: r.deleted,
        reservationReleased: r.reservationReleased,
        notified: r.notified,
        failed: r.failed,
        errors: r.errors.slice(0, 10),
        triggeredBy: r.triggeredBy,
      })),
      pendingRetries,
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
    await ctx.store!.appendAudit({
      actorUid: ctx.auth!.uid,
      actorEmail: ctx.auth!.email,
      action: "cleanup.trigger",
      targetType: "job",
      targetId: run.id,
      requestId: ctx.requestId,
      details: { status: run.status, deleted: run.deleted, failed: run.failed },
    });
    return dataResponse(run);
  },
  { auth: "admin", rateLimit: { limit: 12, windowSec: 60, bucket: "cleanup" } }
);
