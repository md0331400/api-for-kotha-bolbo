/**
 * Google OAuth 2.0 helpers for connecting Drive storage accounts (server-only).
 *
 * - Consent is requested with offline access so refresh tokens can be stored
 *   for background operations (cleanup, downloads).
 * - Only the configured scopes are requested (default: drive.file + identity).
 * - Refresh/access tokens are never returned to any client.
 */
import { ApiError } from "@/lib/errors";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo";

export type GoogleTokenSet = {
  accessToken: string;
  expiresAt: number;
  refreshToken: string | null;
  scope: string;
  idToken?: string;
};

export type GoogleIdentity = {
  email: string | null;
  name: string | null;
  sub: string | null;
};

export function buildAuthUrl(opts: {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
}): string {
  const params = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    response_type: "code",
    scope: opts.scopes.join(" "),
    access_type: "offline",
    include_granted_scopes: "true",
    state: opts.state,
    // Force consent on connect so a refresh token is always returned.
    prompt: "consent",
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

async function tokenRequest(body: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* non-JSON error body */
  }
  if (!res.ok) {
    const err = data.error_description ?? data.error ?? `HTTP ${res.status}`;
    throw new ApiError("PROVIDER_ERROR", `Google OAuth token exchange failed: ${String(err).slice(0, 200)}`);
  }
  return data;
}

export async function exchangeAuthorizationCode(opts: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): Promise<GoogleTokenSet> {
  const data = await tokenRequest({
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    code: opts.code,
    grant_type: "authorization_code",
    redirect_uri: opts.redirectUri,
  });
  const accessToken = String(data.access_token ?? "");
  if (!accessToken) throw new ApiError("PROVIDER_ERROR", "Google OAuth response did not include an access token.");
  return {
    accessToken,
    expiresAt: Date.now() + Number(data.expires_in ?? 3600) * 1000,
    refreshToken: data.refresh_token ? String(data.refresh_token) : null,
    scope: String(data.scope ?? ""),
    idToken: data.id_token ? String(data.id_token) : undefined,
  };
}

export async function refreshAccessToken(opts: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<GoogleTokenSet> {
  const data = await tokenRequest({
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    refresh_token: opts.refreshToken,
    grant_type: "refresh_token",
  });
  const accessToken = String(data.access_token ?? "");
  if (!accessToken) {
    throw new ApiError("PROVIDER_UNAVAILABLE", "Google rejected the stored refresh token (reconnect required).");
  }
  return {
    accessToken,
    expiresAt: Date.now() + Number(data.expires_in ?? 3600) * 1000,
    refreshToken: opts.refreshToken,
    scope: String(data.scope ?? ""),
  };
}

export async function fetchGoogleIdentity(accessToken: string): Promise<GoogleIdentity> {
  const res = await fetch(USERINFO_ENDPOINT, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return { email: null, name: null, sub: null };
  const data = (await res.json()) as { email?: string; name?: string; sub?: string; email_verified?: boolean };
  return {
    // Only trust an email Google reports as verified for identity matching.
    email: data.email && data.email_verified !== false ? data.email : null,
    name: data.name ?? null,
    sub: data.sub ?? null,
  };
}

/**
 * Fallback identity from the ID token returned by the token endpoint. The
 * token arrived over TLS directly from Google in the same exchange, so the
 * payload is trustworthy without signature verification (OIDC Core §3.1.3.7.6)
 * — but it is only used when the UserInfo call did not yield a `sub`, and only
 * when `iss`/`aud` match this client.
 */
export function identityFromIdToken(idToken: string | undefined, clientId: string): GoogleIdentity | null {
  if (!idToken) return null;
  const parts = idToken.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as {
      iss?: string;
      aud?: string;
      sub?: string;
      email?: string;
      email_verified?: boolean;
      name?: string;
      exp?: number;
    };
    const issOk = payload.iss === "https://accounts.google.com" || payload.iss === "accounts.google.com";
    if (!issOk || payload.aud !== clientId) return null;
    if (payload.exp && payload.exp * 1000 < Date.now()) return null;
    return {
      sub: payload.sub ?? null,
      email: payload.email && payload.email_verified !== false ? payload.email : null,
      name: payload.name ?? null,
    };
  } catch {
    return null;
  }
}
