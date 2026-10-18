# Kotha Bolbo Storage API + Admin — Implementation Plan

## Repository inspection results (2026-10-18)

| Question | Finding |
|---|---|
| Framework | **None.** The repository contains a Redmi 7 (`onclite`) kernel audit/build project (Python + shell scripts, Markdown reports, firmware ZIPs). |
| Package manager | None (no `package.json`). |
| Existing routes / backend | None. |
| Database | None. |
| Authentication | None. |
| Deployment config | No `vercel.json`. GitHub repo `md0331400/api-for-kotha-bolbo` has homepage `https://swkf.vercel.app`, so Vercel deploys from this repository. |
| Reusable code | None of the kernel tooling is compatible with a web API. All of it is preserved untouched. |

Decision: build a **Next.js 14 (App Router, TypeScript)** application **at the repository root** (additive — no existing files are deleted or replaced). Next.js is the natural fit for the Vercel runtime at `https://swkf.vercel.app` and provides both the versioned API (`app/api/v1/**`) and the private admin dashboard (`/admin/**`) in one deployment.

## Architecture

- **Runtime:** Vercel Node.js serverless functions (Next.js route handlers). Scheduled work via **Vercel Cron** (no long-running process assumed).
- **Persistent database:** the existing Firebase project's **Realtime Database** (`FIREBASE_DATABASE_URL`), accessed **server-only** through the Firebase Admin SDK. Chosen because it is part of the existing `kotha-bolbo-aso` project, is persistent across serverless invocations, and supports **atomic transactions** (needed for concurrency-safe quota reservations). A `Store` interface isolates all domain operations so a SQL adapter can be substituted later.
- **Identity:** Firebase Authentication (Google + email/password). Every protected endpoint verifies the Firebase **ID token server-side** and derives the UID from the verified token.
- **Storage pool:** multiple Google Drive accounts connected by an administrator via official Google OAuth (offline access). Refresh tokens are stored server-side only (AES-256-GCM encrypted when `CREDENTIALS_ENCRYPTION_KEY` is set) and never returned to any client.
- **Upload flow:** ticket → **direct-to-Google resumable upload** (short-lived session URL, works around the Vercel 4.5 MB request-body limit) → server-side verification of the Drive object (real size, managed folder, ownership claim) → confirmed metadata + quota finalization.
- **Expiry:** `expiresAt = createdAt + 60 days`; cleanup job (cron) deletes expired objects from the correct Drive account idempotently and updates quota; FCM notifications ~7 and ~3 days before expiry when notification infra is configured.

## Stages

1. Scaffold Next.js + TypeScript + Tailwind, `.env.example`, `vercel.json`.
2. Core libs: config, structured errors, logging, request IDs, rate limiting, validation, crypto, IDs, pagination.
3. `Store` domain layer: interface + Realtime Database implementation + test-only in-memory implementation.
4. Storage provider layer: Google Drive REST client + test-only fake provider; account selection, failover, idempotent claims.
5. API v1 routes (public, authenticated, admin, cron).
6. Private admin dashboard (login, overview, Drive accounts, users, files, app version, logs & jobs).
7. Tests (vitest) for auth, quota, idempotency, expiry/cleanup, pagination, admin authz, rate limiting, validation.
8. Documentation: API reference, Vercel deployment, Firebase/Google OAuth setup, security rules, test report.

## Explicit non-claims

- Nothing is marked "working with Google Drive" until it has been exercised against a real authorized account (requires credentials that are not present in this environment).
- No fake data is ever generated: empty deployments show real empty states.

## Status (2026-10-18) — implementation complete in this repository

All stages 1–8 are implemented and verified to the extent possible without external credentials:

- Next.js 14 + TypeScript app at the repository root; `next build` passes (30 routes).
- 22 versioned API endpoints (`/api/v1/...`) + CORS middleware + Vercel Cron registration.
- Admin dashboard: login, overview, Drive accounts (connect/enable/disable/test/disconnect), users
  (search/quota/restrict/purge), files (filters/delete), app version publishing, logs & jobs.
- `Store` domain layer with Realtime Database implementation (production) and a semantics-identical
  in-memory implementation used by 71 passing tests (quota races, idempotency, cleanup, authz).
- `.env.example`, `firebase/database.rules.json`, admin grant/revoke scripts.
- Docs: `docs/API.md`, `docs/DEPLOYMENT.md`, `docs/FIREBASE_SETUP.md`, `docs/TEST_REPORT.md`,
  `docs/README.md`.

See `docs/TEST_REPORT.md` for the exact list of what is tested versus what requires the real
`kotha-bolbo-aso` credentials and Google OAuth configuration to verify.
