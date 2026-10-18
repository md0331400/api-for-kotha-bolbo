#!/usr/bin/env node
/**
 * Grant administrator role to a user UID in the Kotha Bolbo Realtime Database.
 *
 * Usage (server-side only — requires the same env vars as the API):
 *   FIREBASE_PROJECT_ID=... FIREBASE_DATABASE_URL=... \
 *   FIREBASE_CLIENT_EMAIL=... FIREBASE_PRIVATE_KEY=... \
 *   node scripts/admin-grant.mjs <uid> [email]
 *
 * Never run this on a client. Never commit the credentials.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const admin = require("firebase-admin");

function env(name) {
  const v = process.env[name]?.trim();
  if (!v) {
    console.error(`Missing environment variable: ${name}`);
    process.exit(1);
  }
  return v;
}

const uid = process.argv[2];
const email = process.argv[3] ?? null;
if (!uid) {
  console.error("Usage: node scripts/admin-grant.mjs <uid> [email]");
  process.exit(1);
}

const privateKey = env("FIREBASE_PRIVATE_KEY").replace(/\\n/g, "\n");
admin.initializeApp({
  credential: admin.credential.cert({
    projectId: env("FIREBASE_PROJECT_ID"),
    clientEmail: env("FIREBASE_CLIENT_EMAIL"),
    privateKey,
  }),
  databaseURL: env("FIREBASE_DATABASE_URL"),
});

const db = admin.database();
await db.ref(`admins/${uid.replace(/[.#$/[\]]/g, "_")}`).set({
  email,
  grantedAt: Date.now(),
  grantedBy: "scripts/admin-grant.mjs",
});
await db.ref(`auditLogs/log_grant_${Date.now()}`).set({
  id: `log_grant_${Date.now()}`,
  at: Date.now(),
  actorUid: null,
  actorEmail: null,
  action: "admin.grant.script",
  targetType: "admin",
  targetId: uid,
  requestId: null,
  details: { email },
});
console.log(`Granted administrator to ${uid}`);
process.exit(0);
