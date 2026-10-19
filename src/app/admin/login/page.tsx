"use client";

import React, { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Database, Lock, Mail } from "lucide-react";
import { useAuth } from "@/lib/admin/auth-context";
import { Button, ErrorBanner, InfoBanner, Input } from "@/components/admin/ui";

export default function AdminLoginPage() {
  const {
    user,
    session,
    loading,
    firebaseConfigured,
    configIssue,
    configRetrying,
    retryConfig,
    authError,
    signInGoogle,
    signInEmail,
  } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<"google" | "email" | null>(null);

  useEffect(() => {
    if (!loading && user && session?.isAdmin) router.replace("/admin");
  }, [loading, user, session, router]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-900 p-4">
      <div className="w-full max-w-md">
        <div className="rounded-2xl bg-white p-8 shadow-2xl">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-600 text-white">
              <Database className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-lg font-semibold text-slate-900">Kotha Bolbo Storage</h1>
              <p className="text-sm text-slate-500">Private administrator console</p>
            </div>
          </div>

          {!firebaseConfigured ? (
            <div className="mt-6 space-y-2">
              <ErrorBanner
                message={
                  configIssue?.message ??
                  "Firebase web configuration is unavailable. See docs/FIREBASE_SETUP.md."
                }
                code={configIssue ? `CONFIG_${configIssue.kind.toUpperCase().replace("-", "_")}` : undefined}
                onRetry={configIssue?.retryable ? () => void retryConfig() : undefined}
                retrying={configRetrying}
              />
              {configIssue?.missingVariables.length ? (
                <p className="text-xs text-slate-500">
                  Missing:{" "}
                  <span className="font-mono">{configIssue.missingVariables.join(", ")}</span>
                </p>
              ) : null}
            </div>
          ) : (
            <>
              {authError && (
                <div className="mt-5">
                  <ErrorBanner message={authError} />
                </div>
              )}

              <div className="mt-6 space-y-4">
                <Button
                  className="w-full"
                  loading={busy === "google"}
                  onClick={async () => {
                    setBusy("google");
                    try {
                      await signInGoogle();
                    } catch {
                      /* error surfaced via context */
                    } finally {
                      setBusy(null);
                    }
                  }}
                >
                  <svg className="h-4 w-4" viewBox="0 0 24 24" aria-hidden="true">
                    <path
                      fill="currentColor"
                      d="M21.35 11.1H12v2.9h5.35c-.5 2.5-2.6 3.9-5.35 3.9a6 6 0 1 1 0-12c1.5 0 2.9.55 3.95 1.55l2.15-2.15A9 9 0 1 0 12 21c4.65 0 8.85-3.35 8.85-9 0-.3-.05-.6-.1-.9Z"
                    />
                  </svg>
                  Sign in with Google
                </Button>

                <div className="relative py-1 text-center text-xs text-slate-400">
                  <span className="relative z-10 bg-white px-2">or with email and password</span>
                  <div className="absolute inset-x-0 top-1/2 h-px bg-slate-200" />
                </div>

                <form
                  className="space-y-3"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    setBusy("email");
                    try {
                      await signInEmail(email.trim(), password);
                    } catch {
                      /* error surfaced via context */
                    } finally {
                      setBusy(null);
                    }
                  }}
                >
                  <label className="block">
                    <span className="text-xs font-medium text-slate-700">Email</span>
                    <div className="relative mt-1">
                      <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                      <Input
                        type="email"
                        required
                        autoComplete="email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        className="pl-9"
                        placeholder="admin@example.com"
                      />
                    </div>
                  </label>
                  <label className="block">
                    <span className="text-xs font-medium text-slate-700">Password</span>
                    <div className="relative mt-1">
                      <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                      <Input
                        type="password"
                        required
                        autoComplete="current-password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        className="pl-9"
                        placeholder="••••••••"
                      />
                    </div>
                  </label>
                  <Button type="submit" className="w-full" loading={busy === "email"}>
                    Sign in
                  </Button>
                </form>
              </div>
            </>
          )}

          <div className="mt-6">
            <InfoBanner message="Sign-in uses Firebase Authentication. Administrator access is verified server-side on every request." />
          </div>
        </div>
        <p className="mt-4 text-center text-xs text-slate-400">
          Kotha Bolbo Storage API · Private console · <span className="font-mono">swkf.vercel.app</span>
        </p>
      </div>
    </div>
  );
}
