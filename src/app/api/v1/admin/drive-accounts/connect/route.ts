import { NextRequest } from "next/server";
import { apiRoute, dataResponse } from "@/lib/api/handler";
import { ApiError } from "@/lib/errors";
import { newOAuthState } from "@/lib/ids";
import { buildAuthUrl } from "@/lib/storage/google-oauth";
import { createOAuthState, OAUTH_STATE_COOKIE } from "@/lib/storage/oauth-state";

/**
 * GET /api/v1/admin/drive-accounts/connect
 * Starts the Google OAuth connection flow for a new storage account. Returns
 * an authorize URL; the browser is redirected to Google, then back to the
 * callback endpoint. Offline access is requested so the server can perform
 * background operations (uploads, downloads, cleanup).
 */
export const GET = apiRoute(
  async (ctx) => {
    const config = ctx.config!;
    if (!config.googleOAuthClientId || !config.googleOAuthClientSecret) {
      throw new ApiError(
        "CONFIG_MISSING",
        "Google OAuth is not configured. Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET.",
        { details: { missing: ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"] } }
      );
    }
    const nonce = newOAuthState();
    const state = createOAuthState(config.apiSecretKey, ctx.auth!.uid, nonce);
    const redirectUri = `${config.appBaseUrl}/api/v1/admin/drive-accounts/callback`;
    const authorizeUrl = buildAuthUrl({
      clientId: config.googleOAuthClientId,
      redirectUri,
      scopes: config.googleOAuthScopes,
      state,
    });
    await ctx.store!.appendAudit({
      actorUid: ctx.auth!.uid,
      actorEmail: ctx.auth!.email,
      action: "drive.connect.start",
      targetType: "drive_account",
      targetId: "new",
      requestId: ctx.requestId,
      details: { redirectUri },
    });
    const res = dataResponse({ authorizeUrl, redirectUri, stateNonce: nonce });
    // Double-submit cookie binds the callback to this browser session.
    res.headers.set(
      "Set-Cookie",
      `${OAUTH_STATE_COOKIE}=${encodeURIComponent(state)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`
    );
    return res;
  },
  { auth: "admin", rateLimit: { limit: 30, windowSec: 60, bucket: "admin-oauth" } }
);
