"use client";

/**
 * Admin authentication context. Firebase browser sign-in (Google or
 * email/password) plus a server-side administrator check — the server is the
 * only authority on admin privileges.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { User } from "firebase/auth";
import {
  fetchFirebaseWebConfig,
  initFirebaseClient,
  signInWithEmail,
  signInWithGoogle,
  signOut as fbSignOut,
  watchAuth,
} from "@/lib/admin/firebase-client";
import { api, ApiClientError } from "@/lib/admin/api-client";

type AdminSession = {
  uid: string;
  email: string | null;
  displayName: string | null;
  isAdmin: boolean;
};

type AuthState = {
  loading: boolean;
  user: User | null;
  session: AdminSession | null;
  firebaseConfigured: boolean;
  authError: string | null;
  signInGoogle: () => Promise<void>;
  signInEmail: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  refreshSession: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<AdminSession | null>(null);
  const [firebaseConfigured, setFirebaseConfigured] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
    let unsub: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      try {
        const { configured, config } = await fetchFirebaseWebConfig();
        if (cancelled) return;
        if (!configured || !config) {
          setFirebaseConfigured(false);
          setLoading(false);
          return;
        }
        const auth = initFirebaseClient(config);
        unsub = watchAuth(async (u) => {
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
      } catch {
        if (!cancelled) {
          setFirebaseConfigured(false);
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
      if (unsub) unsub();
    };
  }, []);

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
      authError,
      signInGoogle: signInGoogleFn,
      signInEmail: signInEmailFn,
      signOut: signOutFn,
      refreshSession,
    }),
    [loading, user, session, firebaseConfigured, authError, signInGoogleFn, signInEmailFn, signOutFn, refreshSession]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
