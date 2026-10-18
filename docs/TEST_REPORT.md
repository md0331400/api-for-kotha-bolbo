# Test Report — Kotha Bolbo Storage API + Admin

Date: 2026-10-18 · Branch: `arena/36455ede-api-for-kotha-bolbo`

## Summary

| Area | Status | Evidence |
|---|---|---|
| Build (`next build`, TypeScript strict) | ✅ passes | 30 routes generated (8 pages + 22 API handlers + middleware) |
| Unit/integration tests (vitest) | ✅ 71/71 pass | `npm test` — no credentials required |
| Live HTTP smoke test (local `next start`) | ✅ verified | curl results below |
| Firebase Google sign-in | ⛔ requires credentials | needs real `kotha-bolbo-aso` config |
| Email/password authentication | ⛔ requires credentials | same |
| Real Google Drive operations | ⛔ requires credentials | tested against a fake provider only |
| Vercel Cron schedule | ⛔ requires deployment | endpoint itself tested with the cron secret |

## What was tested and passes

### Automated tests (`npm test` — 71 tests, 6 files)

**Configuration (`tests/unit/config.test.ts`)**
- Loads full config; converts escaped private-key newlines.
- Missing config raises `ConfigError` naming **variable names only** (asserts secret values do not appear).
- Rejects short `API_SECRET_KEY` and malformed `CREDENTIALS_ENCRYPTION_KEY`.
- Parses quota/size/TTL/admin-list overrides; public config contains only web values.

**Validation (`tests/unit/validation.test.ts`)**
- Filenames: path traversal (`../`, slashes), control characters, length, NFC normalization.
- Category↔MIME rules for `chat`/`voice`/`photo`/`video`/`other`.
- Upload-ticket schema (sizes, idempotency keys, categories) and structured `VALIDATION_FAILED` details.
- App-version semver + https URL rules.

**Crypto & OAuth state (`tests/unit/crypto-oauth-state.test.ts`)**
- AES-256-GCM round-trip, fresh IVs, tamper/wrong-key rejection, envelope detection.
- HMAC sign/verify; OAuth state round-trip, tamper rejection, expiry enforcement.

**Domain store (`tests/unit/memory-store.test.ts`)**
- Quota reservation accounting (reserve → confirm → release transitions).
- Quota exhaustion rejection (`QUOTA_EXCEEDED`).
- **Concurrent uploads cannot exceed quota** (3×600 MiB race under 1.5 GiB quota → exactly 2 succeed).
- Restricted users cannot upload.
- Idempotent tickets (same `idempotencyKey` → same session, single reservation).
- Idempotent confirm (same file record; quota charged once; verified size applied).
- Cross-user confirm rejected (`FORBIDDEN`).
- Oversized provider object rejected (`BAD_REQUEST`) and reservation released.
- Single-claim of provider objects (duplicate registration rejected).
- Release idempotency (double release frees quota once).
- Stale-ticket cleanup listing.
- Usage recomputation heals counter drift (authoritative rebuild from records).
- Deletion decrements usage; filtering/pagination; expiry windows.
- Admin grant/revoke; audit log filters; rate-limit windows.

**Cleanup job (`tests/unit/cleanup.test.ts`, fake Drive provider)**
- Deletes expired files from the provider and updates quota (`0 B` afterwards).
- Idempotent across repeated runs (second run deletes 0).
- **Refuses to delete objects outside the managed app folder** (protects personal Drive content).
- Missing provider object treated as already-deleted (idempotent).
- Transient provider failure → `pending_delete` + retry entry with backoff; later attempt succeeds and clears the queue.
- Notifications **skipped** (not faked) when no device tokens exist.
- Abandoned-upload orphan objects removed; stale reservations released.

**API routes (`tests/unit/api-routes.test.ts`, mocked Firebase Admin + Drive pool)**
- `/api/v1/health` returns 200 and never leaks secrets.
- `/api/v1/app/version` returns explicit `isPublished:false` with nulls before publish; reflects published metadata afterwards (via admin `PUT`).
- Missing token → `401 UNAUTHENTICATED`; invalid → `401 TOKEN_INVALID`; expired → `401 TOKEN_EXPIRED`.
- Admin endpoints reject non-admins with `403 FORBIDDEN` (server-side check).
- `ADMIN_EMAILS` bootstrap grants admin (audited).
- **Cross-user file read/delete denied** (`403`), owner allowed.
- Fresh user quota is real zeros (`0 B`, `fileCount: 0`, empty category map).
- Upload input validation: oversize → `413`, bad MIME/category → `422`, bad name → `422`.
- Full ticket → provider upload → confirm flow: reservation, 60-day `expiresAt`, idempotent re-confirm, quota moved reserved→used, file listed only for its owner.
- Size-mismatch confirm rejected and reservation released.
- Restricted user upload rejected (`403`).
- Cleanup endpoint rejects anonymous/wrong secret (`401`); runs with `CRON_SECRET`; records a run.

### Live smoke test (production build, `next start`, curl)

Unconfigured deployment (no env vars):
- `GET /api/v1/health` → `200 {"status":"degraded", ... "missingConfigGroups":["FIREBASE_PROJECT_ID", ...]}` — safe, names only.
- `GET /api/v1/app/version` → `200` explicit `isPublished:false`, all null.
- `GET /api/v1/storage/quota` → `503 CONFIG_MISSING` listing missing variable **names**.
- Landing page and `/admin/login` render (`200`).

Configured deployment (dummy env values):
- `GET /api/v1/health` → `{"status":"ok", "firebaseServer":"configured", "googleDriveOAuth":"configured"}`.
- `GET /api/v1/storage/quota` without token → `401 UNAUTHENTICATED`.
- `POST /api/v1/jobs/cleanup` wrong bearer → `401`.
- `POST /api/v1/jobs/cleanup` with `CRON_SECRET` → passes auth; fails later on the *dummy* private key with a generic `500 INTERNAL` (server log shows the Firebase SDK key-parse error; client sees no key material) — expected with fake credentials; exercises the real code path up to the database.
- CORS preflight from allowed origin (`CORS_ORIGINS`) → `204` with `Access-Control-Allow-Origin`; from a disallowed origin → **no** allow-origin header; app origin (`APP_BASE_URL`) allowed. Non-browser clients unaffected.

## What works but still needs real credentials / manual configuration

These are implemented and covered by automated tests against fakes, but **must not be claimed as
verified against real Google/Firebase until run with the real `kotha-bolbo-aso` credentials**:

1. **Firebase Google sign-in and email/password sign-in** — needs real `FIREBASE_API_KEY` etc. and
   `swkf.vercel.app` in Firebase authorized domains.
2. **ID-token verification against Google's public keys** — exercised only via mocked Admin SDK
   (sandbox egress is restricted); the production call `auth.verifyIdToken` is the standard SDK path.
3. **Realtime Database persistence/transactions** — the production `RtdbStore` is a thin
   translation of the tested domain semantics onto RTDB transactions; it needs a live database URL
   (or `FIREBASE_DATABASE_EMULATOR_HOST` locally).
4. **Google Drive OAuth connect flow** — needs a real OAuth client + consent screen and a real
   Google account; redirect URI must be registered (docs/FIREBASE_SETUP.md).
5. **Real Drive upload/download/delete and multi-account failover** — provider behavior is tested
   through `FakeDriveProvider`; `GoogleDriveProvider` implements the official REST endpoints but has
   not been exercised against a live account from this environment. The dashboard deliberately
   shows accounts as **not verified** until the real write test passes.
6. **FCM notifications** — needs messaging configured and device tokens; without them the job
   records `skipped`.
7. **Vercel Cron** — `vercel.json` registers the 6-hour schedule; confirm under Project Settings →
   Cron Jobs after deployment. Free plans run daily.
8. **Dashboard end-to-end (browser)** — built and served (login page renders); sign-in flows need
   real Firebase web config.

## How to complete verification after deployment

Follow `docs/FIREBASE_SETUP.md` §8 (verification checklist) and `docs/DEPLOYMENT.md` §5 (post-deploy
smoke test). Then run one full user journey: sign in → upload ticket → upload → confirm → list →
download → delete, plus one admin journey: connect Drive account (observe “verified”) → change a
quota (observe audit log) → run cleanup. Record the run in this file.

## Test execution

```bash
npm install
npm test        # 71 tests — deterministic, no network, no credentials
npm run build   # production build
```
