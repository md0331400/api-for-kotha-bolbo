import { apiRoute, dataResponse } from "@/lib/api/handler";
import { safeISOString, safeISOStringNullable } from "@/lib/safe-date";

/**
 * GET /api/v1/admin/stats
 * Dashboard overview aggregates from real database records (zero/empty when
 * nothing exists).
 */
export const GET = apiRoute(
  async (ctx) => {
    const store = ctx.store!;
    const now = Date.now();

    const users = await store.listUsers(undefined, { page: 1, pageSize: 1000, offset: 0 });
    const files = await store.listFiles({}, { page: 1, pageSize: 1000, offset: 0 });
    const accounts = await store.listDriveAccounts();
    const expiringSoon = await store.listFiles(
      { expiringInDays: 7, status: "confirmed" },
      { page: 1, pageSize: 1000, offset: 0 }
    );
    const failedUploads = await store.listFailedUploads(100);
    const runs = await store.listCleanupRuns(5);
    const pendingRetries = await store.countPendingRetries();

    const confirmed = files.items.filter((f) => f.status === "confirmed");
    const totalBytes = confirmed.reduce(
      (n, f) => n + (typeof f.sizeBytes === "number" && Number.isFinite(f.sizeBytes) ? f.sizeBytes : 0),
      0
    );

    return dataResponse({
      users: {
        total: users.total,
        restricted: users.items.filter((u) => Boolean(u.restricted)).length,
        totalQuotaBytes: users.items.reduce(
          (n, u) => n + (typeof u.quotaBytes === "number" && Number.isFinite(u.quotaBytes) ? u.quotaBytes : 0),
          0
        ),
      },
      files: {
        total: files.total,
        confirmed: confirmed.length,
        pendingDelete: files.items.filter((f) => f.status === "pending_delete").length,
        deleteFailed: files.items.filter((f) => f.status === "delete_failed").length,
        totalBytes,
      },
      driveAccounts: {
        total: accounts.length,
        enabled: accounts.filter((a) => a.status === "enabled").length,
        disabled: accounts.filter((a) => a.status === "disabled").length,
        disconnected: accounts.filter((a) => a.status === "disconnected").length,
        error: accounts.filter((a) => a.status === "error").length,
        verified: accounts.filter((a) => Boolean(a.verified)).length,
      },
      expiringWithin7Days: expiringSoon.total,
      failedUploads: failedUploads.length,
      recentFailedUploads: failedUploads
        .filter((u) => u && typeof u.id === "string")
        .slice(0, 5)
        .map((u) => ({
          uploadId: u.id,
          category: u.category,
          name: u.name,
          error: u.error ?? null,
          updatedAt: safeISOString((u as unknown as Record<string, unknown>).updatedAt),
        })),
      cleanup: {
        lastRun: runs[0]
          ? {
              id: runs[0].id,
              status: runs[0].status,
              startedAt: safeISOString((runs[0] as unknown as Record<string, unknown>).startedAt),
              finishedAt: safeISOStringNullable((runs[0] as unknown as Record<string, unknown>).finishedAt),
              deleted: typeof runs[0].deleted === "number" ? runs[0].deleted : 0,
              failed: typeof runs[0].failed === "number" ? runs[0].failed : 0,
              errors: Array.isArray(runs[0].errors) ? runs[0].errors.slice(0, 5) : [],
            }
          : null,
        pendingRetries,
      },
      generatedAt: new Date(now).toISOString(),
    });
  },
  { auth: "admin", rateLimit: { limit: 240, windowSec: 60, bucket: "admin" } }
);
