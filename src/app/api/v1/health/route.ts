import { apiRoute, json } from "@/lib/api/handler";
import { missingConfigGroups, hasGoogleOAuthConfig } from "@/lib/config";

/**
 * GET /api/v1/health
 * Public health check. Never exposes secrets or configuration values.
 */
export const GET = apiRoute(
  async ({ requestId }) => {
    const missing = missingConfigGroups();
    const configured = missing.length === 0;
    return json({
      status: configured ? "ok" : "degraded",
      service: "kotha-bolbo-storage-api",
      version: process.env.APP_VERSION ?? "1.0.0",
      time: new Date().toISOString(),
      requestId,
      checks: {
        firebaseServer: configured ? "configured" : "missing",
        googleDriveOAuth: hasGoogleOAuthConfig() ? "configured" : "missing",
        ...(configured ? {} : { missingConfigGroups: missing }),
      },
    });
  },
  { auth: "none", config: "none", rateLimit: { limit: 120, windowSec: 60, bucket: "health" } }
);
