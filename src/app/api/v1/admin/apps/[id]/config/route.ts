import { apiRoute } from "@/lib/api/handler";
import { ApiError } from "@/lib/errors";

/**
 * GET /api/v1/admin/apps/:id/config
 * Downloads a Firebase-shaped client config plus this app's storage-server key.
 * The key is intentionally bundled for client SDK use; server/admin credentials
 * are never included.
 */
export const GET = apiRoute(async (ctx) => {
  const app = await ctx.store!.getApp(ctx.params.id);
  if (!app) throw new ApiError("NOT_FOUND", "Application not found.");
  if (!app.clientApiKey) {
    throw new ApiError("CONFLICT", "This application has no SDK key. Recreate the app config to generate one.");
  }

  const config = ctx.config!;
  const firebase = config.firebaseWeb;
  const payload = {
    configVersion: 1,
    appName: app.name,
    appId: firebase.appId,
    storageAppId: app.id,
    packageName: app.packageName,
    domain: new URL(config.appBaseUrl).host,
    storageApiUrl: config.appBaseUrl.replace(/\\/$/, ""),
    storageApiKey: app.clientApiKey,
    apiKey: firebase.apiKey,
    authDomain: firebase.authDomain,
    databaseURL: firebase.databaseURL,
    projectId: firebase.projectId,
    storageBucket: firebase.storageBucket,
    messagingSenderId: firebase.messagingSenderId,
  };

  return new Response(JSON.stringify(payload, null, 2) + "\n", {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": 'attachment; filename="kotha-bolbo-storage-server.json"',
      "Cache-Control": "no-store, max-age=0",
    },
  });
}, { auth: "admin" });
