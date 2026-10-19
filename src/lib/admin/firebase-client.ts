"use client";

/**
 * Firebase browser SDK (client-safe). Only the public web configuration is
 * used here — Admin SDK credentials never reach this code.
 *
 * The public configuration is read from `GET /api/v1/app/config`. That request
 * can fail for reasons unrelated to Firebase (Vercel Deployment Protection
 * answering with an HTML login page, a 5xx while a deployment starts, or a
 * dropped connection). Every failure is therefore classified so the admin UI
 * can distinguish "the server really has no web configuration" from
 * "the configuration endpoint could not be read right now".
 */
import { getApps, initializeApp, type FirebaseApp } from "firebase/app";
import {
  getAuth,
  signInWithEmailAndPassword,
  signInWithPopup,
  GoogleAuthProvider,
  signOut as fbSignOut,
  onAuthStateChanged,
  type Auth,
  type User,
} from "firebase/auth";

export type FirebaseWebConfig = {
  apiKey: string;
  authDomain: string;
  databaseURL: string;
  projectId: string;
  storageBucket: string;
  messagingSenderId: string;
  appId: string;
};

/** Why the Firebase *web* configuration could not be read. */
export type FirebaseConfigIssueKind =
  /** The server answered correctly and reports the web config is absent. */
  | "missing"
  /** The endpoint answered with a non-2xx status. */
  | "http"
  /** HTML/login/proxy page, malformed JSON, or an incomplete payload. */
  | "invalid-response"
  /** `fetch` itself failed (offline, DNS, connection reset, timeout). */
  | "network";

export type FirebaseConfigErrorKind = Exclude<FirebaseConfigIssueKind, "missing">;

export type FirebaseWebConfigResult = {
  configured: boolean;
  config: FirebaseWebConfig | null;
  /** Names (never values) of the web variables the server reports as absent. */
  missingVariables: string[];
};

const CONFIG_ENDPOINT = "/api/v1/app/config";
const CONFIG_TIMEOUT_MS = 10_000;
const WEB_VARIABLES = ["FIREBASE_API_KEY", "FIREBASE_AUTH_DOMAIN", "FIREBASE_APP_ID"] as const;

/**
 * Typed transport/response failure. `kind` and `retryable` let the UI decide
 * between an actionable message and a retry. Messages never contain values.
 */
export class FirebaseConfigError extends Error {
  readonly kind: FirebaseConfigErrorKind;
  readonly status?: number;
  readonly retryable: boolean;

  constructor(
    kind: FirebaseConfigErrorKind,
    message: string,
    options: { status?: number; retryable: boolean; cause?: unknown }
  ) {
    super(message);
    this.name = "FirebaseConfigError";
    this.kind = kind;
    this.status = options.status;
    this.retryable = options.retryable;
    if (options.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

let app: FirebaseApp | null = null;
let auth: Auth | null = null;

export function initFirebaseClient(config: FirebaseWebConfig): Auth {
  if (auth) return auth;
  if (!getApps().length) {
    app = initializeApp(config);
  } else {
    app = getApps()[0];
  }
  auth = getAuth(app);
  return auth;
}

/** `5xx`, `408` and `429` are worth retrying; `4xx` (auth/protection) is not. */
function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

function describeHttpStatus(status: number): string {
  if (status === 401 || status === 403) {
    return (
      `The configuration endpoint returned HTTP ${status} (access restricted). ` +
      "This usually means the deployment is behind Vercel Deployment Protection or a private " +
      "preview URL — open the production URL instead, or disable protection for that preview."
    );
  }
  return (
    `The configuration endpoint returned HTTP ${status}. ` +
    "The deployment may still be starting — retry in a moment."
  );
}

function isJsonContentType(value: string | null): boolean {
  if (!value) return false;
  return value.split(";")[0].trim().toLowerCase() === "application/json";
}

function isFirebaseWebConfig(value: unknown): value is FirebaseWebConfig {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.apiKey === "string" &&
    candidate.apiKey.length > 0 &&
    typeof candidate.authDomain === "string" &&
    candidate.authDomain.length > 0 &&
    typeof candidate.appId === "string" &&
    candidate.appId.length > 0
  );
}

/**
 * Read the reported missing-variable names, keeping only Firebase *web* names.
 * The API reports names only — never values.
 */
function missingWebVariables(data: Record<string, unknown>): string[] {
  const reported = Array.isArray(data.missingConfigGroups) ? data.missingConfigGroups : [];
  const names = reported.filter((entry): entry is string => typeof entry === "string");
  return WEB_VARIABLES.filter((variable) => names.some((entry) => entry.includes(variable)));
}

/**
 * Message for a failed `fetch`. An `AbortError` means our own 10 s timeout
 * fired; the classification (network, retryable) is the same.
 */
function describeNetworkFailure(cause: unknown): string {
  const name = (cause as { name?: string } | null)?.name;
  if (name === "AbortError" || name === "TimeoutError") {
    return (
      `The configuration endpoint (/api/v1/app/config) did not respond within ` +
      `${CONFIG_TIMEOUT_MS / 1000} seconds. Retry in a moment.`
    );
  }
  return (
    "Could not reach the configuration endpoint (/api/v1/app/config). " +
    "Check your connection and retry."
  );
}

async function readConfigResponse(res: Response): Promise<FirebaseWebConfigResult> {
  if (!res.ok) {
    throw new FirebaseConfigError("http", describeHttpStatus(res.status), {
      status: res.status,
      retryable: isRetryableStatus(res.status),
    });
  }

  const contentType = res.headers.get("content-type");
  if (!isJsonContentType(contentType)) {
    throw new FirebaseConfigError(
      "invalid-response",
      "The configuration endpoint returned a non-JSON response (for example an HTML login or " +
        "proxy page). Open the production URL and reload the page.",
      { status: res.status, retryable: false }
    );
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch (cause) {
    throw new FirebaseConfigError(
      "invalid-response",
      "The configuration endpoint returned malformed JSON. Retry in a moment.",
      { status: res.status, retryable: true, cause }
    );
  }

  const data = (body as { data?: unknown } | null)?.data;
  if (!data || typeof data !== "object") {
    throw new FirebaseConfigError(
      "invalid-response",
      "The configuration endpoint returned an unexpected payload. Retry in a moment.",
      { status: res.status, retryable: true }
    );
  }

  const record = data as Record<string, unknown>;
  if (record.firebaseWebConfigured === false) {
    return { configured: false, config: null, missingVariables: missingWebVariables(record) };
  }

  if (record.firebaseWebConfigured !== true) {
    throw new FirebaseConfigError(
      "invalid-response",
      "The configuration endpoint returned an unexpected payload. Retry in a moment.",
      { status: res.status, retryable: true }
    );
  }

  if (!isFirebaseWebConfig(record.firebase)) {
    throw new FirebaseConfigError(
      "invalid-response",
      "The configuration endpoint reported Firebase as configured but the payload is incomplete. " +
        "Retry in a moment.",
      { status: res.status, retryable: true }
    );
  }

  return { configured: true, config: record.firebase, missingVariables: [] };
}

/**
 * Fetch the public Firebase web configuration.
 *
 * Resolves only when the endpoint answered with valid JSON. A genuinely absent
 * configuration resolves with `configured: false`; transport problems,
 * HTML/proxy responses and non-2xx statuses throw `FirebaseConfigError`.
 */
export async function fetchFirebaseWebConfig(): Promise<FirebaseWebConfigResult> {
  const controller = typeof AbortController === "undefined" ? null : new AbortController();
  const timer = controller ? setTimeout(() => controller.abort(), CONFIG_TIMEOUT_MS) : null;

  let res: Response;
  try {
    res = await fetch(CONFIG_ENDPOINT, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
      credentials: "same-origin",
      redirect: "follow",
      signal: controller?.signal,
    });
  } catch (cause) {
    throw new FirebaseConfigError("network", describeNetworkFailure(cause), {
      retryable: true,
      cause,
    });
  } finally {
    if (timer) clearTimeout(timer);
  }

  return readConfigResponse(res);
}

export type FirebaseConfigRetryOptions = {
  /** Total attempts including the first one. Default 3. */
  attempts?: number;
  /** Delay before the first retry; doubles per attempt. Default 400 ms. */
  baseDelayMs?: number;
  /** Injectable for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * `fetchFirebaseWebConfig` with bounded exponential backoff. Only failures
 * marked retryable (network, 5xx, 408, 429, transient bad payload) are retried;
 * an HTML login page or a 401/403 fails immediately because retrying repeats
 * the same response.
 */
export async function fetchFirebaseWebConfigWithRetry(
  options: FirebaseConfigRetryOptions = {}
): Promise<FirebaseWebConfigResult> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const baseDelayMs = Math.max(0, options.baseDelayMs ?? 400);
  const sleep = options.sleep ?? defaultSleep;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetchFirebaseWebConfig();
    } catch (error) {
      lastError = error;
      const retryable = error instanceof FirebaseConfigError ? error.retryable : false;
      if (!retryable || attempt === attempts) throw error;
      await sleep(baseDelayMs * 2 ** (attempt - 1));
    }
  }

  throw lastError;
}

export async function signInWithGoogle(): Promise<User> {
  const a = auth ?? (() => {
    throw new Error("Firebase client not initialized");
  })();
  const provider = new GoogleAuthProvider();
  const cred = await signInWithPopup(a, provider);
  return cred.user;
}

export async function signInWithEmail(email: string, password: string): Promise<User> {
  const a = auth ?? (() => {
    throw new Error("Firebase client not initialized");
  })();
  const cred = await signInWithEmailAndPassword(a, email, password);
  return cred.user;
}

export async function signOut(): Promise<void> {
  if (auth) await fbSignOut(auth);
}

export function watchAuth(cb: (user: User | null) => void): () => void {
  const a = auth ?? (() => {
    throw new Error("Firebase client not initialized");
  })();
  return onAuthStateChanged(a, cb);
}
