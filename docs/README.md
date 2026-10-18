# Kotha Bolbo Storage API + Admin — Project Guide

Secure, production-oriented API backend and private admin dashboard for the Kotha Bolbo
application, deployed at **https://swkf.vercel.app/**.

> **Note:** this repository also contains an unrelated, pre-existing Redmi 7 (`onclite`) kernel
> audit project (firmware ZIPs, `scripts/*.py`, `installer/`, `reports/`, `BUILD_REPORT.md`). Those
> files are untouched and play no part in the web application. This guide covers the web app only.

## What this is

- **Versioned REST API** under `/api/v1/` used by the Kotha Bolbo website and Android APK for
  temporary user files (chat, voice, photos, videos, other).
- **Private admin dashboard** at `/admin` (Firebase sign-in + server-verified administrator role).
- **Multi-account Google Drive storage pool** connected by administrators through official Google
  OAuth; the server stores and uses refresh tokens; clients never see provider credentials.
- **Per-user 2 GiB quota** with concurrency-safe reservations, **60-day retention** with scheduled
  cleanup, expiry notifications (optional), app-version/update metadata, audit logging.

## Layout

| Path | Purpose |
|---|---|
| `src/app/api/v1/**` | API route handlers (health, storage, admin, cron) |
| `src/app/admin/**` | Admin dashboard pages (login, overview, drive, users, files, version, logs) |
| `src/lib/**` | Config, auth, domain store, Drive provider, services (cleanup/notifications) |
| `tests/unit/**` | Vitest suite (71 tests; fakes for Firebase/Drive — no credentials needed) |
| `firebase/database.rules.json` | Deny-all client rules + indexes for the Realtime Database |
| `scripts/admin-grant.mjs`, `scripts/admin-revoke.mjs` | Server-side admin role management |
| `vercel.json` | Vercel Cron for the cleanup job |
| `.env.example` | All environment variables, empty placeholders only |

## Documentation

| Document | Contents |
|---|---|
| [docs/API.md](API.md) | Full API reference: auth, envelopes, every endpoint, examples |
| [docs/DEPLOYMENT.md](DEPLOYMENT.md) | Vercel setup, environment variables, cron, first admin, security checklist |
| [docs/FIREBASE_SETUP.md](FIREBASE_SETUP.md) | Firebase auth/DB/FCM + Google OAuth & Drive configuration |
| [docs/TEST_REPORT.md](TEST_REPORT.md) | What is tested and passes; what needs credentials |
| [docs/IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) | Repository inspection results and architecture decisions |

## Quick start (local)

```bash
cp .env.example .env   # fill in values from the kotha-bolbo-aso Firebase project
npm install
npm run dev            # http://localhost:3000  → admin at /admin
npm test               # run the test suite (no credentials required)
```

## Security model (short version)

- Identity: Firebase Authentication (Google + email/password). Every protected endpoint verifies
  the ID token server-side and derives the UID from it.
- Authorization: file ownership on every operation; administrator checks server-side (`admins`).
- Storage: Google Drive `drive.file` scope in a managed app folder — personal drive content is
  untouchable and is never deleted; provider objects are claimed idempotently.
- Secrets: Vercel env vars only; refresh tokens encrypted at rest (optional key); no secrets in
  client bundles, responses, or logs.
- Quotas: transactional reservation → provider-verified finalize; cleanup releases abandoned
  reservations and reconciles counters from authoritative records.
- Scheduled cleanup protected by `CRON_SECRET`; OAuth state signed + expiring; CORS allowlist.

The API never claims end-to-end encryption (it is not implemented): files are private objects in
the connected Google accounts' managed folder, protected by Google account security and our
authorization layer.
