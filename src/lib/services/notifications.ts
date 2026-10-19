/**
 * Expiry notifications via Firebase Cloud Messaging.
 *
 * Notifications are best-effort: they require Firebase Messaging to be
 * configured and at least one registered device token. Nothing is faked when
 * the infrastructure is absent — the attempt is recorded as `skipped`.
 */
import { requireAdminSdk } from "@/lib/firebase-admin";
import type { Store } from "@/lib/db/store";
import type { FileRecord } from "@/lib/db/types";
import { logger } from "@/lib/logger";
import { safeISOString } from "@/lib/safe-date";

export async function notifyFileExpiring(
  store: Store,
  file: FileRecord,
  daysBefore: number
): Promise<"sent" | "skipped" | "failed"> {
  const id = `${file.id}_${daysBefore}`;
  const tokens = await store.listNotificationTokens(file.uid);
  if (!tokens.length) {
    await store.markNotificationSent({
      id,
      uid: file.uid,
      fileId: file.id,
      daysBefore,
      sentAt: Date.now(),
      status: "skipped",
    });
    return "skipped";
  }
  try {
    const { messaging } = requireAdminSdk();
    const res = await messaging.sendEachForMulticast({
      tokens: tokens.map((t) => t.token),
      data: {
        type: "storage_file_expiring",
        fileId: file.id,
        fileName: file.name,
        daysBefore: String(daysBefore),
        expiresAt: safeISOString((file as unknown as Record<string, unknown>).expiresAt) ?? "",
      },
      notification: {
        title: "Storage file expiring soon",
        body: `"${file.name}" will be deleted in ${daysBefore} day${daysBefore === 1 ? "" : "s"}.`,
      },
      android: { priority: "high" },
      webpush: { headers: { Urgency: "high" } },
    });
    const status = res.failureCount > 0 && res.successCount === 0 ? "failed" : "sent";
    await store.markNotificationSent({
      id,
      uid: file.uid,
      fileId: file.id,
      daysBefore,
      sentAt: Date.now(),
      status,
    });
    return status;
  } catch (e) {
    logger.warn("notify.failed", { fileId: file.id, error: e instanceof Error ? e.message : String(e) });
    await store.markNotificationSent({
      id,
      uid: file.uid,
      fileId: file.id,
      daysBefore,
      sentAt: Date.now(),
      status: "failed",
    });
    return "failed";
  }
}
