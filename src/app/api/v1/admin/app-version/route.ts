import { apiRoute, dataResponse } from "@/lib/api/handler";
import { parseOrThrow, appVersionSchema } from "@/lib/validation";

/**
 * GET /api/v1/admin/app-version
 * Current app-version configuration (or explicit unpublished state).
 */
export const GET = apiRoute(
  async (ctx) => {
    const rec = await ctx.store!.getAppVersion();
    return dataResponse(
      rec ?? {
        isPublished: false,
        currentVersion: null,
        minSupportedVersion: null,
        updateUrl: null,
        forceUpdate: false,
        releaseNotes: null,
        publishedAt: null,
        publishedBy: null,
      }
    );
  },
  { auth: "admin", rateLimit: { limit: 240, windowSec: 60, bucket: "admin" } }
);

/**
 * PUT /api/v1/admin/app-version
 * Publishes validated version metadata for the APK/website update flow.
 */
export const PUT = apiRoute(
  async (ctx) => {
    const body = parseOrThrow(appVersionSchema, await (async () => {
      try {
        return await ctx.req.json();
      } catch {
        return {};
      }
    })());
    const rec = {
      currentVersion: body.currentVersion,
      minSupportedVersion: body.minSupportedVersion,
      updateUrl: body.updateUrl ?? "",
      forceUpdate: body.forceUpdate,
      releaseNotes: body.releaseNotes ?? null,
      publishedAt: Date.now(),
      publishedBy: ctx.auth!.uid,
    };
    await ctx.store!.putAppVersion(rec);
    await ctx.store!.appendAudit({
      actorUid: ctx.auth!.uid,
      actorEmail: ctx.auth!.email,
      action: "app_version.publish",
      targetType: "app_version",
      targetId: rec.currentVersion,
      requestId: ctx.requestId,
      details: {
        currentVersion: rec.currentVersion,
        minSupportedVersion: rec.minSupportedVersion,
        forceUpdate: rec.forceUpdate,
      },
    });
    return dataResponse(rec);
  },
  { auth: "admin", rateLimit: { limit: 240, windowSec: 60, bucket: "admin" } }
);
