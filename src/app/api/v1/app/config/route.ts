import { apiRoute, dataResponse, json } from "@/lib/api/handler";
import { publicFirebaseWebConfig, missingConfigGroups } from "@/lib/config";

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
        missingConfigGroups: configured ? [] : missingConfigGroups().concat(
          web.apiKey ? [] : ["FIREBASE_API_KEY / FIREBASE_AUTH_DOMAIN / FIREBASE_APP_ID (client)"]
        ),
      },
    });
  },
  { auth: "none", config: "none", rateLimit: { limit: 60, windowSec: 60, bucket: "app-config" } }
);
