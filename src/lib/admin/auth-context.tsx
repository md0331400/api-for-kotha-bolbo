"use client";

/**
 * Admin authentication context. Firebase browser sign-in (Google or
 * email/password) plus a server-side administrator check — the server is the
 * only authority on admin privileges.
 *
 * Reading the public Firebase web configuration is retried with backoff and
 * classified: a genuinely absent configuration is reported as missing, while
 * HTML/login pages, HTTP errors and network failures are reported as
 * configuration-*endpoint* problems with a retry action.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { User } from "firebase/auth";
import {
  FirebaseConfigError,
  fetchFirebaseWebConfigWithRetry,
  initFirebaseClient,
  signInWithEmail,
  signInWithGoogle,
  signOut as fbSignOut,
  watchAuth,
  type FirebaseConfigIssueKind,
} from "@/lib/admin/firebase-client";
import { api, ApiClientError } from "@/lib/admin/api-client";

type AdminSession = {
  uid: string;
  email: string | null;
  displayName: string | null;
  isAdmin: boolean;
};

export type FirebaseConfigIssue = {
  kind: FirebaseConfigIssueKind;
  /** Safe, actionable message. Contains variable names only, never values. */
  message: string;
  retryable: boolean;
  /** Reported missing variable names (empty when unknown). */
  missingVariables: string[];
};

type AuthState = {
  loading: boolean;
  user: User | null;
  session: AdminSession | null;
  firebaseConfigured: boolean;
  configIssue: FirebaseConfigIssue | null;
  configRetrying: boolean;
  retryConfig: () => Promise<void>;
  authError: string | null;
  signInGoogle: () => Promise<void>;
  signInEmail: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  refreshSession: () => Promise<void>;
};

const MISSING_MESSAGE =
  "Firebase web configuration is missing on the server. Set FIREBASE_API_KEY, " +
  "FIREBASE_AUTH_DOMAIN and FIREBASE_APP_ID for this Vercel environment, then redeploy " +
  "(see docs/FIREBASE_SETUP.md).";

const AuthContext = createContext<AuthState | null>(null);

function issueFromError(error: unknown): FirebaseConfigIssue {
  if (error instanceof FirebaseConfigError) {
    return { kind: error.kind, message: error.message, retryable: error.retryable, missingVariables: [] };
  }
  return {
    kind: "network",
    message:
      "Could not reach the configuration endpoint (/api/v1/app/config). " +
      "Check your connection and retry.",
    retryable: true,
    missingVariables: [],
  };
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<AdminSession | null>(null);
  const [firebaseConfigured, setFirebaseConfigured] = useState(true);
  const [configIssue, setConfigIssue] = useState<FirebaseConfigIssue | null>(null);
  const [configRetrying, setConfigRetrying] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  // Invalidates in-flight configuration loads on unmount / Strict Mode remount.
  const runIdRef = useRef(0);
  // Ensures only the newest manual retry owns the `configRetrying` flag.
  const retrySeqRef = useRef(0);
  const unsubRef = useRef<(() => void) | null>(null);

  const startAuthWatch = useCallback(() => {
    if (unsubRef.current) return;
    unsubRef.current = watchAuth(async (u) => {
      setUser(u);
      if (!u) {
        setSession(null);
        setLoading(false);
        return;
      }
      try {
        const s = await api.get<AdminSession>(u, "/api/v1/admin/session");
        setSession(s);
        setAuthError(null);
      } catch (e) {
        if (e instanceof ApiClientError && (e.status === 403 || e.status === 401)) {
          setSession(null);
          setAuthError(
            e.status === 403
              ? "This account does not have administrator privileges on the server."
              : "Your session is not valid. Sign in again."
          );
        } else {
          setAuthError(e instanceof Error ? e.message : "Could not verify administrator session.");
        }
      } finally {
        setLoading(false);
      }
    });
  }, []);

  const loadConfig = useCallback(async () => {
    // Every load claims a new sequence number — mount, Strict Mode remount and
    // manual retry alike. Older in-flight requests can no longer update state.
    const runId = ++runIdRef.current;
    try {
      const { configured, config, missingVariables } = await fetchFirebaseWebConfigWithRetry();
      if (runId !== runIdRef.current) return;
      if (!configured || !config) {
        setFirebaseConfigured(false);
        setConfigIssue({
          kind: "missing",
          message: MISSING_MESSAGE,
          retryable: true,
          missingVariables,
        });
        setLoading(false);
        return;
      }
      setConfigIssue(null);
      setFirebaseConfigured(true);
      initFirebaseClient(config);
      startAuthWatch();
    } catch (error) {
      if (runId !== runIdRef.current) return;
      setFirebaseConfigured(false);
      setConfigIssue(issueFromError(error));
      setLoading(false);
    }
  }, [startAuthWatch]);

  useEffect(() => {
    void loadConfig();
    return () => {
      // Invalidate this mount's request and drop its auth subscription.
      runIdRef.current += 1;
      if (unsubRef.current) {
        unsubRef.current();
        unsubRef.current = null;
      }
    };
  }, [loadConfig]);

  const retryConfig = useCallback(async () => {
    const retryId = ++retrySeqRef.current;
    setConfigRetrying(true);
    try {
      // loadConfig bumps the run id, so this retry supersedes any in-flight load.
      await loadConfig();
    } finally {
      // Only the newest retry may clear the spinner.
      if (retryId === retrySeqRef.current) setConfigRetrying(false);
    }
  }, [loadConfig]);

  const signInGoogleFn = useCallback(async () => {
    setAuthError(null);
    try {
      await signInWithGoogle();
    } catch (e) {
      setAuthError(e instanceof Error ? e.message : "Google sign-in failed.");
      throw e;
    }
  }, []);

  const signInEmailFn = useCallback(async (email: string, password: string) => {
    setAuthError(null);
    try {
      await signInWithEmail(email, password);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Sign-in failed.";
      setAuthError(
        /password|credential|user-not-found|wrong/i.test(msg)
          ? "Invalid email or password."
          : msg
      );
      throw e;
    }
  }, []);

  const signOutFn = useCallback(async () => {
    await fbSignOut();
    setUser(null);
    setSession(null);
  }, []);

  const refreshSession = useCallback(async () => {
    if (!user) return;
    const s = await api.get<AdminSession>(user, "/api/v1/admin/session");
    setSession(s);
  }, [user]);

  const value = useMemo<AuthState>(
    () => ({
      loading,
      user,
      session,
      firebaseConfigured,
      configIssue,
      configRetrying,
      retryConfig,
      authError,
      signInGoogle: signInGoogleFn,
      signInEmail: signInEmailFn,
      signOut: signOutFn,
      refreshSession,
    }),
    [
      loading,
      user,
      session,
      firebaseConfigured,
      configIssue,
      configRetrying,
      retryConfig,
      authError,
      signInGoogleFn,
      signInEmailFn,
      signOutFn,
      refreshSession,
    ]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
