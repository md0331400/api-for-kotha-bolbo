/**
 * Server-only Firebase Admin SDK initialization.
 *
 * Credentials come exclusively from environment variables:
 *   FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY / FIREBASE_PROJECT_ID /
 *   FIREBASE_DATABASE_URL
 *
 * Private keys never reach the client bundle (all usages are inside API route
 * handlers and server modules). Missing configuration produces a safe error
 * naming the variables only.
 */
import { cert, deleteApp, getApp, getApps, initializeApp, type App } from "firebase-admin/app";
import { getAuth, type Auth } from "firebase-admin/auth";
import { getDatabase, type Database } from "firebase-admin/database";
import { getMessaging, type Messaging } from "firebase-admin/messaging";
import { ConfigError, hasAdminCredentials, hasDatabaseConfig, missingConfigGroups } from "@/lib/config";

let cached: { app: App; auth: Auth; db: Database; messaging: Messaging } | null = null;

export function firebaseConfigError(): ConfigError | null {
  const missing = missingConfigGroups();
  return missing.length ? new ConfigError(missing) : null;
}

export function requireAdminSdk() {
  if (cached) return cached;
  if (!hasAdminCredentials() || !hasDatabaseConfig()) {
    throw firebaseConfigError() ?? new ConfigError(["FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY"]);
  }
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL!.trim();
  const projectId = (process.env.FIREBASE_PROJECT_ID ?? "").trim();
  const databaseURL = process.env.FIREBASE_DATABASE_URL!.trim();
  const privateKey = process.env.FIREBASE_PRIVATE_KEY!.replace(/\\n/g, "\n");

  const app = getApps().length
    ? getApp()
    : initializeApp({
        credential: cert({ projectId, clientEmail, privateKey }),
        databaseURL,
        projectId,
      });
  const auth = getAuth(app);
  const db = getDatabase(app);
  const messaging = getMessaging(app);
  cached = { app, auth, db, messaging };
  return cached;
}

/** Reset cached handles (used by tests). */
export async function resetAdminSdk() {
  if (cached) {
    try {
      await deleteApp(cached.app);
    } catch {
      /* ignore */
    }
    cached = null;
  }
}
