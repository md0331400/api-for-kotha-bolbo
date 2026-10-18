import { apiRoute, dataResponse, ensureUser } from "@/lib/api/handler";
import { parseOrThrow, notificationTokenSchema } from "@/lib/validation";

async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

/**
 * POST /api/v1/notifications/token
 * Registers an FCM device token for expiry notifications. Optional — when no
 * notification infrastructure or tokens exist, notifications are skipped
 * (never faked).
 */
export const POST = apiRoute(
  async (ctx) => {
    const body = parseOrThrow(notificationTokenSchema, await readJson(ctx.req));
    const user = await ensureUser(ctx);
    await ctx.store!.registerNotificationToken({
      uid: user.uid,
      token: body.token,
      platform: body.platform,
      updatedAt: Date.now(),
    });
    return dataResponse({ registered: true });
  },
  { auth: "user", scope: "notifications:write", rateLimit: { limit: 30, windowSec: 60, bucket: "notif-token" } }
);
