"use client";

/**
 * Authenticated API client for the admin dashboard. Attaches the Firebase ID
 * token to every request and surfaces structured API errors.
 */
import type { User } from "firebase/auth";

export class ApiClientError extends Error {
  code: string;
  status: number;
  details: unknown;
  requestId?: string;
  constructor(status: number, code: string, message: string, details?: unknown, requestId?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }
}

async function idToken(user: User): Promise<string> {
  return user.getIdToken();
}

export type PageMeta = { page: number; pageSize: number; total: number; totalPages: number; hasMore: boolean };

/** Server list envelope: `{ data: T[], pagination }`. */
export type Paginated<T> = { data: T[]; pagination: PageMeta };

/**
 * Perform an authenticated request and return the *raw* parsed JSON envelope
 * (`{ data }` or `{ data, pagination }`). Non-2xx responses throw
 * {@link ApiClientError} with the server's code/message/requestId.
 */
async function requestEnvelope(
  user: User,
  method: string,
  path: string,
  body?: unknown,
  opts?: { signal?: AbortSignal }
): Promise<unknown> {
  let token: string;
  try {
    token = await idToken(user);
  } catch (e) {
    throw new ApiClientError(401, "TOKEN_INVALID", e instanceof Error ? e.message : "Could not obtain a Firebase ID token.");
  }
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: opts?.signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new ApiClientError(0, "NETWORK_ERROR", "Network error — could not reach the API. Check your connection and retry.");
  }
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON */
  }
  const requestId = res.headers.get("x-request-id") ?? undefined;
  if (!res.ok) {
    const err = (parsed as { error?: { code?: string; message?: string; details?: unknown; requestId?: string } })?.error;
    throw new ApiClientError(
      res.status,
      err?.code ?? (res.status >= 500 ? "INTERNAL" : "BAD_REQUEST"),
      err?.message ?? `Request failed with HTTP ${res.status}.`,
      err?.details,
      err?.requestId ?? requestId
    );
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new ApiClientError(res.status, "BAD_RESPONSE", "The API returned an unexpected (non-JSON) response.", undefined, requestId);
  }
  return parsed;
}

/** Single-resource request: unwraps `{ data }`. */
async function request<T>(user: User, method: string, path: string, body?: unknown, opts?: { signal?: AbortSignal }): Promise<T> {
  const parsed = (await requestEnvelope(user, method, path, body, opts)) as { data?: T };
  return parsed.data !== undefined ? parsed.data : (parsed as unknown as T);
}

/**
 * Paginated list request: returns BOTH `data` and `pagination`. (Previously the
 * envelope was unwrapped to the bare array, which made `pagination` undefined
 * and broke the Users / Files / Logs pages.)
 */
async function requestPage<T>(user: User, path: string, signal?: AbortSignal): Promise<Paginated<T>> {
  const parsed = (await requestEnvelope(user, "GET", path, undefined, { signal })) as Partial<Paginated<T>>;
  if (!Array.isArray(parsed.data)) {
    throw new ApiClientError(200, "BAD_RESPONSE", "The API returned a list response without a data array.");
  }
  const total = parsed.pagination?.total ?? parsed.data.length;
  const pageSize = parsed.pagination?.pageSize ?? Math.max(1, parsed.data.length);
  return {
    data: parsed.data,
    pagination: parsed.pagination ?? {
      page: 1,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      hasMore: false,
    },
  };
}

export const api = {
  get: <T,>(user: User, path: string, signal?: AbortSignal) => request<T>(user, "GET", path, undefined, { signal }),
  getPage: <T,>(user: User, path: string, signal?: AbortSignal) => requestPage<T>(user, path, signal),
  post: <T,>(user: User, path: string, body?: unknown) => request<T>(user, "POST", path, body ?? {}),
  patch: <T,>(user: User, path: string, body?: unknown) => request<T>(user, "PATCH", path, body ?? {}),
  put: <T,>(user: User, path: string, body?: unknown) => request<T>(user, "PUT", path, body ?? {}),
  del: <T,>(user: User, path: string) => request<T>(user, "DELETE", path),
};

export type UiError = { message: string; code?: string; requestId?: string; status?: number };

/**
 * Turn any thrown value into a message the dashboard can show. Server
 * messages are preferred; infrastructure failures get specific guidance.
 */
export function describeError(e: unknown, fallback: string): UiError {
  if (e instanceof ApiClientError) {
    let message = e.message;
    if (e.status === 401) message = `${e.message} Sign in again if this persists.`;
    else if (e.status === 403) message = `${e.message} (administrator privileges are checked on the server)`;
    else if (e.status === 503 && e.code === "CONFIG_MISSING") {
      const missing = (e.details as { missing?: string[] } | undefined)?.missing;
      message = `Server configuration is incomplete${missing?.length ? `: ${missing.join(", ")}` : ""}.`;
    } else if (e.status === 429) message = `${e.message} (rate limited)`;
    return { message, code: e.code, requestId: e.requestId, status: e.status };
  }
  if (e instanceof Error) return { message: `${fallback} ${e.message}`.trim() };
  return { message: fallback };
}
