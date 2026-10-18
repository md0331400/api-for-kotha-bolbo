/**
 * Scheduled cleanup: expired-file deletion, abandoned reservation release,
 * retry processing, expiry notifications, and usage reconciliation.
 *
 * The job is idempotent and safe to run concurrently: all state transitions
 * are guarded (deleting a missing provider object counts as success; releasing
 * a released reservation is a no-op). It is triggered by Vercel Cron or an
 * administrator — never by anonymous callers.
 */
import type { AppConfig } from "@/lib/config";
import type { Store } from "@/lib/db/store";
import type { CleanupRunRecord, FileRecord } from "@/lib/db/types";
import { ApiError, isApiError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { newRunId } from "@/lib/ids";
import { getDriveProvider } from "@/lib/storage/pool";
import type { StorageProvider } from "@/lib/storage/provider";
import { notifyFileExpiring } from "@/lib/services/notifications";

const MAX_DELETE_ATTEMPTS = 8;
const RETRY_BASE_MS = 15 * 60 * 1000; // 15 min, exponential
const RETRY_MAX_MS = 6 * 60 * 60 * 1000; // cap 6 h
const BATCH = 200;

/** Injectable provider factory (tests substitute a fake; production uses pool). */
export type ProviderFactory = (store: Store, config: AppConfig, accountId: string) => Promise<StorageProvider>;

export type CleanupResult = {
  run: CleanupRunRecord;
};

function backoffMs(attempts: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * Math.pow(2, Math.max(0, attempts - 1)));
}

/**
 * Delete one file object from the provider and finalize its record.
 *
 * Safety: only the exact provider file id recorded at upload time is deleted,
 * and only after verifying the object lives in the account's managed app
 * folder — personal-drive content is never touched.
 */
export async function deleteFileFully(
  store: Store,
  config: AppConfig,
  file: FileRecord,
  opts: { actor: string; adminUid?: string; providerFactory?: ProviderFactory }
): Promise<{ ok: boolean; error?: string; alreadyGone?: boolean }> {
  const getProvider = opts.providerFactory ?? getDriveProvider;
  const attempts = (file.deleteAttempts ?? 0) + 1;
  const account = await store.getDriveAccount(file.providerAccountId);
  if (!account) {
    await store.updateFileRecord(file.id, {
      status: "delete_failed",
      deleteAttempts: attempts,
      lastDeleteError: "Provider account no longer exists.",
    });
    return { ok: false, error: "Provider account no longer exists." };
  }

  try {
    const provider = await getProvider(store, config, file.providerAccountId);
    const meta = await provider.getFileMeta(file.providerFileId);
    if (meta) {
      if (account.managedFolderId && meta.parents.length && !meta.parents.includes(account.managedFolderId)) {
        const msg = "Object is outside the managed app folder — refusing to delete.";
        await store.updateFileRecord(file.id, {
          status: "delete_failed",
          deleteAttempts: attempts,
          lastDeleteError: msg,
        });
        return { ok: false, error: msg };
      }
      await provider.deleteFile(file.providerFileId);
    }
    await store.updateFileRecord(file.id, {
      status: "deleted",
      deletedAt: Date.now(),
      deleteAttempts: attempts,
      lastDeleteError: undefined,
      ...(opts.adminUid ? { deletedBy: opts.adminUid } : {}),
    });
    await store.deleteRetryEntry(file.id).catch(() => undefined);
    return { ok: true, alreadyGone: !meta };
  } catch (e) {
    const message = isApiError(e) ? e.message : "Provider deletion failed.";
    const permanent = attempts >= MAX_DELETE_ATTEMPTS;
    await store.updateFileRecord(file.id, {
      status: permanent ? "delete_failed" : "pending_delete",
      deleteAttempts: attempts,
      lastDeleteError: message,
    });
    if (!permanent) {
      await store
        .putRetryEntry({
          fileId: file.id,
          attempts,
          nextAttemptAt: Date.now() + backoffMs(attempts),
          lastError: message,
          updatedAt: Date.now(),
        })
        .catch(() => undefined);
    } else {
      logger.error("cleanup.delete_permanent_failure", { fileId: file.id, attempts, message });
    }
    return { ok: false, error: message };
  }
}

export async function runCleanup(
  store: Store,
  config: AppConfig,
  opts: { triggeredBy: string; providerFactory?: ProviderFactory }
): Promise<CleanupResult> {
  const getProvider = opts.providerFactory ?? getDriveProvider;
  const now = Date.now();
  const run: CleanupRunRecord = {
    id: newRunId(),
    startedAt: now,
    finishedAt: null,
    status: "running",
    scanned: 0,
    deleted: 0,
    reservationReleased: 0,
    notified: 0,
    failed: 0,
    errors: [],
    triggeredBy: opts.triggeredBy,
  };
  await store.recordCleanupRun(run);
  const touchedUsers = new Set<string>();

  try {
    // 1. Release reservations for abandoned/expired upload tickets.
    const stale = await store.listUploadsForCleanup(now, BATCH);
    for (const s of stale) {
      const res = await store.releaseUploadReservation(s.id, "TICKET_EXPIRED");
      if (res.released) {
        run.reservationReleased += 1;
        touchedUsers.add(s.uid);
        // A provider object may have been uploaded without confirm — surface it
        // so reconciliation can remove the orphan if it was recorded.
        if (s.providerFileId && s.providerAccountId && s.status !== "confirmed") {
          const account = await store.getDriveAccount(s.providerAccountId);
          if (account?.managedFolderId && s.providerFileId) {
            try {
              const provider = await getProvider(store, config, s.providerAccountId);
              const meta = await provider.getFileMeta(s.providerFileId);
              if (meta && meta.parents.includes(account.managedFolderId)) {
                await provider.deleteFile(s.providerFileId);
                logger.info("cleanup.orphan_removed", { uploadId: s.id });
              }
            } catch (e) {
              logger.warn("cleanup.orphan_failed", {
                uploadId: s.id,
                error: e instanceof Error ? e.message : String(e),
              });
            }
          }
        }
      }
    }

    // 2. Delete expired files (60-day retention).
    const expired = await store.listExpiredFiles(now, BATCH);
    for (const f of expired) {
      run.scanned += 1;
      const res = await deleteFileFully(store, config, f, { actor: opts.triggeredBy, providerFactory: getProvider });
      touchedUsers.add(f.uid);
      if (res.ok) run.deleted += 1;
      else {
        run.failed += 1;
        run.errors.push({ fileId: f.id, message: res.error ?? "delete failed" });
      }
    }

    // 3. Retry queue due entries.
    const retries = await store.listRetryEntries(now, BATCH);
    for (const entry of retries) {
      const f = await store.getFile(entry.fileId);
      if (!f || f.status === "deleted") {
        await store.deleteRetryEntry(entry.fileId).catch(() => undefined);
        continue;
      }
      run.scanned += 1;
      const res = await deleteFileFully(store, config, f, { actor: opts.triggeredBy, providerFactory: getProvider });
      touchedUsers.add(f.uid);
      if (res.ok) run.deleted += 1;
      else {
        run.failed += 1;
        run.errors.push({ fileId: f.id, message: res.error ?? "retry failed" });
      }
    }

    // 4. Pending deletions without an active retry entry (e.g. admin purge).
    const pending = await store.listFiles({ status: "pending_delete" }, { page: 1, pageSize: BATCH, offset: 0 });
    for (const f of pending.items) {
      const entry = await store.getRetryEntry(f.id);
      if (entry && entry.nextAttemptAt > now) continue;
      run.scanned += 1;
      const res = await deleteFileFully(store, config, f, { actor: opts.triggeredBy, providerFactory: getProvider });
      touchedUsers.add(f.uid);
      if (res.ok) run.deleted += 1;
      else {
        run.failed += 1;
        run.errors.push({ fileId: f.id, message: res.error ?? "pending delete failed" });
      }
    }

    // 5. Expiry notifications (~7 and ~3 days before expiry) when configured.
    for (const days of config.notifyExpiryDays) {
      const from = now + (days - 1) * 86_400_000;
      const to = now + days * 86_400_000;
      const soon = await store.listExpiringBetween(from, to, BATCH);
      for (const f of soon) {
        const already = await store.listNotificationsSentForFile(f.id);
        if (already.some((n) => n.daysBefore === days)) continue;
        const status = await notifyFileExpiring(store, f, days);
        if (status === "sent") run.notified += 1;
        touchedUsers.add(f.uid);
      }
    }

    // 6. Reconcile derived counters for every user touched in this run.
    for (const uid of touchedUsers) {
      await store.recomputeUserUsage(uid).catch((e) => {
        logger.warn("cleanup.recompute_failed", { uid, error: e instanceof Error ? e.message : String(e) });
      });
    }

    run.finishedAt = Date.now();
    run.status = run.failed === 0 ? "success" : "partial";
  } catch (e) {
    run.finishedAt = Date.now();
    run.status = "failed";
    run.errors.push({ message: e instanceof ApiError ? e.message : "cleanup crashed" });
    logger.error("cleanup.crashed", { error: e instanceof Error ? e.message : String(e) });
  }

  await store.updateCleanupRun(run.id, run);
  logger.info("cleanup.finished", {
    runId: run.id,
    status: run.status,
    deleted: run.deleted,
    failed: run.failed,
    released: run.reservationReleased,
    notified: run.notified,
  });
  return { run };
}
