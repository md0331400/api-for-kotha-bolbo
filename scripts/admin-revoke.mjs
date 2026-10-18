#!/usr/bin/env node
/**
 * Revoke administrator role from a user UID.
 *
 * Usage (server-side only):
 *   FIREBASE_PROJECT_ID=... FIREBASE_DATABASE_URL=... \
 *   FIREBASE_CLIENT_EMAIL=... FIREBASE_PRIVATE_KEY=... \
 *   node scripts/admin-revoke.mjs <uid>
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
if (!uid) {
  console.error("Usage: node scripts/admin-revoke.mjs <uid>");
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
await db.ref(`admins/${uid.replace(/[.#$/[\]]/g, "_")}`).remove();
console.log(`Revoked administrator from ${uid}`);
process.exit(0);
