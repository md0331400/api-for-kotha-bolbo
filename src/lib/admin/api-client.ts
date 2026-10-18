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

async function request<T>(
  user: User,
  method: string,
  path: string,
  body?: unknown,
  opts?: { signal?: AbortSignal }
): Promise<T> {
  const token = await idToken(user);
  const res = await fetch(path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: opts?.signal,
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON */
  }
  if (!res.ok) {
    const err = (parsed as { error?: { code?: string; message?: string; details?: unknown; requestId?: string } })?.error;
    throw new ApiClientError(
      res.status,
      err?.code ?? "INTERNAL",
      err?.message ?? `Request failed (${res.status})`,
      err?.details,
      err?.requestId
    );
  }
  return (parsed as { data?: T }).data !== undefined ? ((parsed as { data: T }).data) : (parsed as T);
}

export const api = {
  get: <T,>(user: User, path: string, signal?: AbortSignal) => request<T>(user, "GET", path, undefined, { signal }),
  post: <T,>(user: User, path: string, body?: unknown) => request<T>(user, "POST", path, body ?? {}),
  patch: <T,>(user: User, path: string, body?: unknown) => request<T>(user, "PATCH", path, body ?? {}),
  put: <T,>(user: User, path: string, body?: unknown) => request<T>(user, "PUT", path, body ?? {}),
  del: <T,>(user: User, path: string) => request<T>(user, "DELETE", path),
};

export type Paginated<T> = {
  items?: T[];
  data?: T[];
  pagination?: { page: number; pageSize: number; total: number; totalPages: number; hasMore: boolean };
};

export function unwrapList<T>(res: unknown): { items: T[]; total: number } {
  if (Array.isArray(res)) return { items: res as T[], total: (res as T[]).length };
  const r = res as { data?: T[]; pagination?: { total: number } };
  return { items: r.data ?? [], total: r.pagination?.total ?? (r.data?.length ?? 0) };
}
