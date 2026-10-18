import { apiRoute } from "@/lib/api/handler";
import { logger } from "@/lib/logger";
import { exchangeAuthorizationCode, fetchGoogleIdentity, identityFromIdToken } from "@/lib/storage/google-oauth";
import { clearTokenCache, encryptRefreshToken, getDriveProvider, recordAccountError } from "@/lib/storage/pool";
import { OAUTH_STATE_COOKIE, verifyOAuthState } from "@/lib/storage/oauth-state";
import { resolveOrCreateDriveAccount } from "@/lib/storage/account-identity";

/**
 * GET /api/v1/admin/drive-accounts/callback
 * Google OAuth redirect target. Authenticates the initiating administrator via
 * the signed state (there is no bearer token on a browser redirect). Exchanges
 * the code server-side, resolves the Google account identity (`sub` + email),
 * and either creates ONE storage-account record or reconnects the existing
 * one — the same Google account can never produce a second pool record.
 * Credentials are stored encrypted, the managed folder is provisioned, and a
 * real write test decides whether the account is presented as verified.
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
      // Never touch stored credentials when Google did not issue a new token.
      return fail("Google did not return a refresh token. Ensure offline access is granted and retry.");
    }

    // Verified identity: UserInfo first, ID token as fallback for `sub`.
    const userInfo = await fetchGoogleIdentity(tokens.accessToken);
    const fromIdToken = identityFromIdToken(tokens.idToken, config.googleOAuthClientId);
    const identity = {
      sub: userInfo.sub ?? fromIdToken?.sub ?? null,
      email: userInfo.email ?? fromIdToken?.email ?? null,
      name: userInfo.name ?? fromIdToken?.name ?? null,
    };
    if (!identity.sub && !identity.email) {
      return fail("Google did not return a verifiable account identity. Grant the email scope and retry.");
    }

    let resolved;
    try {
      resolved = await resolveOrCreateDriveAccount(store, identity, { scope: tokens.scope });
    } catch (e) {
      logger.warn("drive.callback.identity_failed", { reason: e instanceof Error ? e.message : "unknown" });
      return fail("Could not resolve the Google account identity. Retry the connection.");
    }
    const { account, created, conflicts } = resolved;

    // Store (or rotate) the refresh token — only ever with a token Google just issued.
    await store.saveDriveToken({
      accountId: account.id,
      refreshToken: encryptRefreshToken(config, tokens.refreshToken),
      scope: tokens.scope,
      obtainedAt: Date.now(),
    });
    clearTokenCache(account.id);
    if (!created) {
      // Reconnect: bring a disconnected/errored record back; keep admin "disabled".
      const reactivate = account.status === "disconnected" || account.status === "error";
      await store.updateDriveAccount(account.id, {
        ...(reactivate ? { status: "enabled" as const, disabledReason: null } : {}),
        lastErrorMessage: null,
        displayName: identity.name ?? account.displayName,
        accountEmail: identity.email ?? account.accountEmail,
      });
    }

    // Provision managed folder and verify with a real write/delete.
    let verified = false;
    try {
      const provider = await getDriveProvider(store, config, account.id);
      const current = (await store.getDriveAccount(account.id)) ?? account;
      const folderId = current.managedFolderId ?? (await provider.ensureManagedFolder()).id;
      if (!current.managedFolderId) await store.updateDriveAccount(account.id, { managedFolderId: folderId });
      await provider.testOperation(folderId);
      await store.updateDriveAccount(account.id, {
        verified: true,
        lastSuccessAt: Date.now(),
        lastErrorAt: null,
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
      action: created ? "drive.connect.complete" : "drive.reconnect.complete",
      targetType: "drive_account",
      targetId: account.id,
      requestId: ctx.requestId,
      details: {
        accountEmail: identity.email,
        hasGoogleAccountId: Boolean(identity.sub),
        verified,
        duplicateOf: conflicts.length ? conflicts : undefined,
      },
    });
    if (conflicts.length) {
      logger.warn("drive.connect.duplicates_detected", { accountId: account.id, conflicts });
    }

    const email = encodeURIComponent(identity.email ?? account.id);
    const flag = created ? "connected=1" : "reconnected=1";
    return Response.redirect(`${base}?${flag}&account=${email}&verified=${verified ? 1 : 0}`, 302);
  },
  { auth: "none", config: "required", rateLimit: { limit: 30, windowSec: 60, bucket: "admin-oauth" } }
);
