import { apiRoute, dataResponse } from "@/lib/api/handler";
import { safeISOString } from "@/lib/safe-date";

/**
 * GET /api/v1/app/version
 * Public app-version/update metadata (used by the Android APK and website).
 * When an administrator has not published a version yet, the response is
 * explicitly unpublished (no fabricated values).
 */
export const GET = apiRoute(
  async ({ store }) => {
    if (!store) {
      return dataResponse({
        isPublished: false,
        currentVersion: null,
        minSupportedVersion: null,
        updateUrl: null,
        forceUpdate: false,
        releaseNotes: null,
        publishedAt: null,
      });
    }
    const rec = await store.getAppVersion();
    if (!rec) {
      return dataResponse({
        isPublished: false,
        currentVersion: null,
        minSupportedVersion: null,
        updateUrl: null,
        forceUpdate: false,
        releaseNotes: null,
        publishedAt: null,
      });
    }
    return dataResponse({
      isPublished: true,
      currentVersion: rec.currentVersion,
      minSupportedVersion: rec.minSupportedVersion,
      updateUrl: rec.updateUrl || null,
      forceUpdate: rec.forceUpdate,
      releaseNotes: rec.releaseNotes,
      publishedAt: safeISOString(rec.publishedAt as unknown as number),
    });
  },
  { auth: "none", config: "optional", rateLimit: { limit: 120, windowSec: 60, bucket: "app" } }
);
