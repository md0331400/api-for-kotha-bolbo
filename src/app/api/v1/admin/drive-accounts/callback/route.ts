import { apiRoute } from "@/lib/api/handler";
import { logger } from "@/lib/logger";
import { exchangeAuthorizationCode, fetchGoogleIdentity } from "@/lib/storage/google-oauth";
import { encryptRefreshToken, getDriveProvider, recordAccountError } from "@/lib/storage/pool";
import { OAUTH_STATE_COOKIE, verifyOAuthState } from "@/lib/storage/oauth-state";

/**
 * GET /api/v1/admin/drive-accounts/callback
 * Google OAuth redirect target. Authenticates the initiating administrator via
 * the signed state (there is no bearer token on a browser redirect). Exchanges
 * the code server-side, stores the refresh token encrypted, provisions the
 * managed folder, and runs a real write test — the account is only presented
 * as connected/verified after that succeeds.
 */
export const GET = apiRoute(
  async (ctx) => {
    const config = ctx.config!;
    const store = ctx.store!;
    const base = `${config.appBaseUrl}/admin/drive`;
    const qp = ctx.req.nextUrl.searchParams;
    const code = qp.get("code");
    const state = qp.get("state");
    const oauthError = qp.get("error");

    const fail = (message: string) =>
      Response.redirect(`${base}?error=${encodeURIComponent(message.slice(0, 200))}`, 302);

    if (oauthError) return fail(`Google OAuth error: ${oauthError}`);
    if (!code || !state) return fail("Missing OAuth code or state.");

    // Validate state (HMAC + expiry + optional double-submit cookie).
    let initiatorUid: string;
    try {
      const payload = verifyOAuthState(config.apiSecretKey, state);
      initiatorUid = payload.uid;
    } catch (e) {
      logger.warn("drive.callback.bad_state", { reason: e instanceof Error ? e.message : "unknown" });
      return fail("Invalid or expired OAuth state. Start the connection again.");
    }
    const cookieHeader = ctx.req.headers.get("cookie") ?? "";
    const cookieMatch = new RegExp(`${OAUTH_STATE_COOKIE}=([^;]+)`).exec(cookieHeader);
    if (cookieMatch && decodeURIComponent(cookieMatch[1]) !== state) {
      return fail("OAuth state cookie mismatch. Start the connection again.");
    }
    if (!(await store.isAdmin(initiatorUid))) {
      return fail("Administrator session is no longer valid.");
    }

    const redirectUri = `${config.appBaseUrl}/api/v1/admin/drive-accounts/callback`;
    const tokens = await exchangeAuthorizationCode({
      clientId: config.googleOAuthClientId,
      clientSecret: config.googleOAuthClientSecret,
      code,
      redirectUri,
    });
    if (!tokens.refreshToken) {
      return fail("Google did not return a refresh token. Ensure offline access is granted and retry.");
    }
    const identity = await fetchGoogleIdentity(tokens.accessToken);

    const account = await store.createDriveAccount({
      accountEmail: identity.email,
      displayName: identity.name,
      scope: tokens.scope,
    });
    await store.saveDriveToken({
      accountId: account.id,
      refreshToken: encryptRefreshToken(config, tokens.refreshToken),
      scope: tokens.scope,
      obtainedAt: Date.now(),
    });

    // Provision managed folder and verify with a real write/delete.
    let verified = false;
    try {
      const provider = await getDriveProvider(store, config, account.id);
      const folder = await provider.ensureManagedFolder();
      await store.updateDriveAccount(account.id, { managedFolderId: folder.id });
      await provider.testOperation(folder.id);
      await store.updateDriveAccount(account.id, {
        verified: true,
        lastSuccessAt: Date.now(),
        lastErrorMessage: null,
      });
      verified = true;
    } catch (e) {
      const message = e instanceof Error ? e.message : "verification failed";
      await recordAccountError(store, account.id, message);
      logger.warn("drive.connect.verify_failed", { accountId: account.id });
    }

    await store.appendAudit({
      actorUid: initiatorUid,
      actorEmail: null,
      action: "drive.connect.complete",
      targetType: "drive_account",
      targetId: account.id,
      requestId: ctx.requestId,
      details: { accountEmail: identity.email, verified },
    });

    const email = encodeURIComponent(identity.email ?? account.id);
    return Response.redirect(`${base}?connected=1&account=${email}&verified=${verified ? 1 : 0}`, 302);
  },
  { auth: "none", config: "required", rateLimit: { limit: 30, windowSec: 60, bucket: "admin-oauth" } }
);
