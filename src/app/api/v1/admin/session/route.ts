import { apiRoute, dataResponse } from "@/lib/api/handler";

/**
 * GET /api/v1/admin/session
 * Lightweight endpoint used by the dashboard to verify that the signed-in
 * Firebase user actually has server-side administrator privileges.
 */
export const GET = apiRoute(
  async (ctx) => {
    return dataResponse({
      uid: ctx.auth!.uid,
      email: ctx.auth!.email,
      displayName: ctx.auth!.displayName,
      isAdmin: ctx.auth!.isAdmin,
    });
  },
  { auth: "admin", rateLimit: { limit: 240, windowSec: 60, bucket: "admin" } }
);
