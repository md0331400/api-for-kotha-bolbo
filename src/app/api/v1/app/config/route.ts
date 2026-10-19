import { apiRoute, dataResponse, json } from "@/lib/api/handler";
import { publicFirebaseWebConfig, missingConfigGroups, type FirebaseWebConfig } from "@/lib/config";

/** Names (never values) of the browser-facing variables that are absent. */
function missingWebVariables(web: FirebaseWebConfig): string[] {
  const missing: string[] = [];
  if (!web.apiKey) missing.push("FIREBASE_API_KEY");
  if (!web.authDomain) missing.push("FIREBASE_AUTH_DOMAIN");
  if (!web.appId) missing.push("FIREBASE_APP_ID");
  return missing;
}

/**
 * GET /api/v1/app/config
 * Public, client-safe Firebase *web* configuration used by the admin login
 * page. This is project identification, not a secret — Security Rules and
 * server authorization remain mandatory. Never includes Admin SDK credentials.
 */
export const GET = apiRoute(
  async () => {
    const web = publicFirebaseWebConfig();
    const configured = Boolean(web.apiKey && web.authDomain && web.appId);
    return json({
      data: {
        firebaseWebConfigured: configured,
        firebase: configured ? web : null,
        missingConfigGroups: configured
          ? []
          : missingWebVariables(web).concat(missingConfigGroups()),
      },
    });
  },
  { auth: "none", config: "none", rateLimit: { limit: 60, windowSec: 60, bucket: "app-config" } }
);
