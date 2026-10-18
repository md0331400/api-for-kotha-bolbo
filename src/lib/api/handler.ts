/**
 * Shared API route wrapper: request IDs, structured errors, CORS, rate
 * limiting, Firebase ID-token verification, and server-side admin checks.
 */
import { NextRequest, NextResponse } from "next/server";
import type { DecodedIdToken } from "firebase-admin/auth";
import type { ApiKeyScope, UserRecord } from "@/lib/db/types";
import { requireAdminSdk } from "@/lib/firebase-admin";
import { API_KEY_HEADER, hasScope, verifyApiKey } from "@/lib/api/api-keys";
import { ConfigError, loadConfig, type AppConfig } from "@/lib/config";
import { ApiError, errorBody, internalError, isApiError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { newRequestId } from "@/lib/ids";
import { getStore, type Store } from "@/lib/api/store-singleton";

export type AuthContext = {
  uid: string;
  email: string | null;
  displayName: string | null;
  isAdmin: boolean;
  /** How the principal authenticated. API keys can never be administrators. */
  via: "firebase" | "api_key";
  /** Present only for API-key principals. */
  apiKey: { id: string; name: string; scopes: ApiKeyScope[] } | null;
  /** Verified Firebase token (null for API-key principals). */
  decoded: DecodedIdToken | null;
};

export type HandlerCtx = {
  req: NextRequest;
  params: Record<string, string>;
  requestId: string;
  config: AppConfig | null;
  store: Store | null;
  auth: AuthContext | null;
  ip: string;
};

export type RouteOptions = {
  auth?: "none" | "user" | "admin";
  /**
   * Permission required when the caller authenticates with a client API key
   * (`X-API-Key`). Routes without a scope reject API keys entirely (fail
   * closed); Firebase ID-token callers are unaffected.
   */
  scope?: ApiKeyScope;
  /** "required" (default) loads config and the store; "optional" allows missing config. */
  config?: "required" | "optional" | "none";
  rateLimit?: { limit: number; windowSec: number; bucket: string };
};

type RateLimitRule = { limit: number; windowSec: number; bucket: string };

const RATE_LIMITS: Record<string, RateLimitRule> = {
  default: { limit: 120, windowSec: 60, bucket: "default" },
  uploadTicket: { limit: 30, windowSec: 60, bucket: "upload-ticket" },
  uploadConfirm: { limit: 60, windowSec: 60, bucket: "upload-confirm" },
  download: { limit: 60, windowSec: 60, bucket: "download" },
  authFree: { limit: 60, windowSec: 60, bucket: "auth-free" },
  admin: { limit: 240, windowSec: 60, bucket: "admin" },
  job: { limit: 12, windowSec: 60, bucket: "job" },
};

export function json<T>(body: T, init?: { status?: number; headers?: Record<string, string> }): Response {
  return NextResponse.json(body as object, {
    status: init?.status ?? 200,
    headers: init?.headers,
  });
}

export function dataResponse<T>(data: T, init?: { status?: number }): Response {
  return json({ data }, init);
}

export function paginatedResponse<T>(
  data: T[],
  pagination: { page: number; pageSize: number; total: number; totalPages: number; hasMore: boolean },
  init?: { status?: number }
): Response {
  return json({ data, pagination }, init);
}

function clientIp(req: NextRequest): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}

function corsHeaders(req: NextRequest, config: AppConfig | null): Record<string, string> {
  const origin = req.headers.get("origin");
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Authorization,Content-Type,X-API-Key,X-Idempotency-Key,X-Request-Id",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (!origin) return headers;
  const allowed = new Set<string>([config?.appBaseUrl ?? "", ...(config?.corsOrigins ?? [])].filter(Boolean));
  if (allowed.has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Credentials"] = "false";
  }
  return headers;
}

async function verifyBearerToken(req: NextRequest): Promise<DecodedIdToken> {
  const header = req.headers.get("authorization") ?? "";
  if (!header.toLowerCase().startsWith("bearer ")) {
    throw new ApiError(
      "UNAUTHENTICATED",
      "Missing credentials. Send Authorization: Bearer <Firebase ID token> or X-API-Key: <client API key>."
    );
  }
  const token = header.slice(7).trim();
  if (!token) throw new ApiError("UNAUTHENTICATED", "Empty bearer token.");
  try {
    const { auth } = requireAdminSdk();
    return await auth.verifyIdToken(token);
  } catch (e) {
    const code = (e as { code?: string })?.code ?? "";
    if (code.includes("expired")) {
      throw new ApiError("TOKEN_EXPIRED", "Firebase ID token has expired. Refresh the token and retry.");
    }
    if (code.includes("argument") || code.includes("invalid")) {
      throw new ApiError("TOKEN_INVALID", "Firebase ID token is invalid.");
    }
    if (e instanceof ConfigError) throw e;
    throw new ApiError("TOKEN_INVALID", "Firebase ID token could not be verified.");
  }
}

/**
 * Authenticate with a client API key. API keys act on behalf of the Firebase
 * UID they were issued for, are never administrators, and must carry the
 * scope the route declares.
 */
async function resolveApiKeyAuth(
  rawKey: string,
  store: Store,
  mode: "user" | "admin",
  requiredScope: ApiKeyScope | undefined
): Promise<AuthContext> {
  if (mode === "admin") {
    throw new ApiError("FORBIDDEN", "Administrator endpoints require a Firebase ID token; API keys are not accepted.");
  }
  const { record } = await verifyApiKey(store, rawKey);
  if (!requiredScope) {
    throw new ApiError("FORBIDDEN", "This endpoint does not accept API keys.");
  }
  if (!hasScope(record.scopes, requiredScope)) {
    throw new ApiError("FORBIDDEN", `API key is missing the required scope: ${requiredScope}.`, {
      details: { requiredScope, grantedScopes: record.scopes },
    });
  }
  return {
    uid: record.subjectUid,
    email: null,
    displayName: null,
    isAdmin: false,
    via: "api_key",
    apiKey: { id: record.id, name: record.name, scopes: record.scopes },
    decoded: null,
  };
}

async function resolveAuth(
  req: NextRequest,
  store: Store,
  config: AppConfig,
  mode: "none" | "user" | "admin",
  requiredScope: ApiKeyScope | undefined
): Promise<AuthContext | null> {
  if (mode === "none") return null;
  const hasBearer = (req.headers.get("authorization") ?? "").toLowerCase().startsWith("bearer ");
  const apiKeyHeader = req.headers.get(API_KEY_HEADER);
  if (!hasBearer && apiKeyHeader && apiKeyHeader.trim()) {
    return resolveApiKeyAuth(apiKeyHeader, store, mode, requiredScope);
  }
  const decoded = await verifyBearerToken(req);
  const uid = decoded.uid;
  if (!uid) throw new ApiError("TOKEN_INVALID", "Token has no subject (uid).");

  let isAdmin = await store.isAdmin(uid);
  const email = decoded.email ?? null;
  if (!isAdmin && email && config.adminEmails.includes(email.toLowerCase())) {
    // First-run bootstrap from ADMIN_EMAILS (documented, server-side only).
    await store.grantAdmin(uid, email, "bootstrap:ADMIN_EMAILS");
    await store.appendAudit({
      actorUid: uid,
      actorEmail: email,
      action: "admin.bootstrap",
      targetType: "admin",
      targetId: uid,
      requestId: null,
      details: { source: "ADMIN_EMAILS" },
    });
    isAdmin = true;
    logger.info("admin.bootstrap_granted", { uid });
  }
  if (mode === "admin" && !isAdmin) {
    throw new ApiError("FORBIDDEN", "Administrator privileges are required for this endpoint.");
  }
  return {
    uid,
    email,
    displayName: decoded.name ?? null,
    isAdmin,
    via: "firebase",
    apiKey: null,
    decoded,
  };
}

/**
 * Wrap a route handler with the shared pipeline. Route handlers receive a
 * context and must return a Response (use `dataResponse` / `json`).
 */
export function apiRoute(
  handler: (ctx: HandlerCtx) => Promise<Response>,
  opts: RouteOptions = {}
): (req: NextRequest, routeCtx?: { params?: Record<string, string> }) => Promise<Response> {
  return async (req: NextRequest, routeCtx?: { params?: Record<string, string> }) => {
    const requestId = newRequestId();
    const started = Date.now();
    const ip = clientIp(req);
    let config: AppConfig | null = null;
    let store: Store | null = null;
    let status = 200;
    let auth: AuthContext | null = null;

    try {
      const configMode = opts.config ?? "required";
      if (configMode !== "none") {
        try {
          config = loadConfig();
        } catch (e) {
          if (e instanceof ConfigError && configMode === "optional") {
            config = null;
          } else {
            throw e;
          }
        }
      }
      if (config) {
        store = getStore();
        await store.ensureSchema().catch(() => undefined);
      }

      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: { ...corsHeaders(req, config), "X-Request-Id": requestId } });
      }

      if ((opts.auth ?? "user") !== "none") {
        if (!store || !config) throw new ConfigError(["FIREBASE_* server configuration"]);
        auth = await resolveAuth(req, store, config, opts.auth ?? "user", opts.scope);
      }

      // Rate limiting (fail-open on infra errors; logged).
      const rl = opts.rateLimit ?? RATE_LIMITS.default;
      if (store && config) {
        try {
          const key = `${rl.bucket}:${auth?.uid ?? ip}`;
          const hit = await store.rateLimitHit(key, rl.limit, rl.windowSec);
          if (!hit.allowed) {
            throw new ApiError("RATE_LIMITED", "Too many requests. Slow down and retry later.", {
              details: { retryAfterSec: Math.ceil((hit.resetAt - Date.now()) / 1000) },
            });
          }
        } catch (e) {
          if (isApiError(e) && e.code === "RATE_LIMITED") throw e;
          logger.warn("ratelimit.degraded", { requestId });
        }
      }

      const params = routeCtx?.params ?? {};
      const res = await handler({ req, params, requestId, config, store, auth, ip });
      status = res.status;
      const headers = new Headers(res.headers);
      headers.set("X-Request-Id", requestId);
      for (const [k, v] of Object.entries(corsHeaders(req, config))) headers.set(k, v);
      return new Response(res.body, { status: res.status, headers });
    } catch (e) {
      let apiErr: ApiError;
      if (isApiError(e)) {
        apiErr = e;
      } else if (e instanceof ConfigError) {
        apiErr = new ApiError("CONFIG_MISSING", e.message, { details: { missing: e.missing } });
      } else {
        logger.error("request.unhandled_error", {
          requestId,
          path: req.nextUrl.pathname,
          error: e instanceof Error ? e.message : String(e),
          stack: e instanceof Error ? e.stack?.slice(0, 1000) : undefined,
        });
        apiErr = internalError(e);
      }
      status = apiErr.status;
      const headers = new Headers(corsHeaders(req, config));
      headers.set("X-Request-Id", requestId);
      headers.set("Content-Type", "application/json; charset=utf-8");
      return new Response(JSON.stringify(errorBody(apiErr, requestId)), { status: apiErr.status, headers });
    } finally {
      const durationMs = Date.now() - started;
      if (req.method !== "OPTIONS") {
        logger.info("request", {
          requestId,
          method: req.method,
          path: req.nextUrl.pathname,
          status,
          durationMs,
          uid: auth?.uid,
          admin: auth?.isAdmin ? true : undefined,
          credentialId: auth?.apiKey?.id, // public key id (ak_…), never the secret
        });
      }
    }
  };
}

/**
 * Create (or fetch) the durable user record for an authenticated principal.
 * UID always comes from the verified token — never from the request body.
 */
export async function ensureUser(ctx: HandlerCtx): Promise<UserRecord> {
  const store = ctx.store!;
  const auth = ctx.auth!;
  const existing = await store.getUser(auth.uid);
  if (existing) return existing;
  return store.upsertUserOnLogin({
    uid: auth.uid,
    email: auth.email,
    displayName: auth.displayName,
    photoURL: null,
  });
}
