# Vercel Deployment Instructions

Production URL: **https://swkf.vercel.app/**

The repository `md0331400/api-for-kotha-bolbo` is a Next.js 14 application at the repository root.
The pre-existing kernel-audit files (ZIPs, `scripts/*.py`, `installer/`, `reports/`) are untouched
and ignored by the build.

## 1. Vercel project

1. Import/pick the GitHub repository in Vercel (the project already exists — its homepage is
   `https://swkf.vercel.app`).
2. **Framework preset:** Next.js (auto-detected). **Root directory:** repository root (do not set a
   subdirectory). **Build command:** `next build` (default). **Install command:** `npm install`.
3. Node.js version: 18.18+ (20.x or 22.x recommended).

## 2. Environment variables

Set these in **Project Settings → Environment Variables** for Production (and Preview/Development
as needed). `.env.example` documents every variable with empty placeholders — never commit real
values, and never use a `NEXT_PUBLIC_` / `VITE_` prefix for anything secret.

### Public (client-safe)

| Variable | Value |
|---|---|
| `APP_BASE_URL` | `https://swkf.vercel.app` |
| `CORS_ORIGINS` | extra browser origins allowed to call the API (comma-separated), e.g. the Kotha Bolbo website origin |
| `FIREBASE_API_KEY` | from Firebase console (web config) |
| `FIREBASE_AUTH_DOMAIN` | `kotha-bolbo-aso.firebaseapp.com` (verify in console) |
| `FIREBASE_DATABASE_URL` | the project's Realtime Database URL |
| `FIREBASE_PROJECT_ID` | `kotha-bolbo-aso` |
| `FIREBASE_STORAGE_BUCKET` | from Firebase console |
| `FIREBASE_MESSAGING_SENDER_ID` | from Firebase console |
| `FIREBASE_APP_ID` | from Firebase console |

### Server-only (never expose)

| Variable | Value |
|---|---|
| `FIREBASE_CLIENT_EMAIL` | service-account `client_email` |
| `FIREBASE_PRIVATE_KEY` | service-account `private_key` (keep the `\n` escapes exactly as the console provides them; the app converts `\\n` → newline at runtime) |
| `API_SECRET_KEY` | ≥32 random chars — HMAC key for OAuth state (e.g. `openssl rand -base64 48`) |
| `CRON_SECRET` | ≥16 random chars — protects the cleanup endpoint; Vercel Cron sends it automatically |
| `CREDENTIALS_ENCRYPTION_KEY` | 64 hex chars (`openssl rand -hex 32`) — encrypts stored Google refresh tokens at rest (strongly recommended) |
| `GOOGLE_OAUTH_CLIENT_ID` | Google OAuth web client |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Google OAuth web client secret |

### Policy (optional overrides)

| Variable | Default |
|---|---|
| `DEFAULT_USER_QUOTA_BYTES` | `2147483648` (2 GiB) |
| `MAX_UPLOAD_BYTES` | `536870912` (512 MiB per file) |
| `FILE_TTL_DAYS` | `60` |
| `NOTIFY_EXPIRY_DAYS` | `7,3` |
| `UPLOAD_TICKET_TTL_MINUTES` | `60` |
| `ADMIN_EMAILS` | empty (comma-separated bootstrap admins) |
| `APP_VERSION` | `1.0.0` (display only until an admin publishes) |

If configuration is missing, endpoints return `503 CONFIG_MISSING` listing the missing **variable
names** only.

## 3. Database (Firebase Realtime Database)

The persistent store is the existing Firebase project's Realtime Database — it survives serverless
restarts and supports the transactions used for quota reservation.

1. Firebase Console → Realtime Database → create/enable it in the `kotha-bolbo-aso` project
   (production mode first, then apply rules).
2. Deploy the security rules in [`firebase/database.rules.json`](../firebase/database.rules.json) —
   they deny **all** client access; every read/write goes through the Admin SDK on the server:

   ```bash
   firebase deploy --only database --project kotha-bolbo-aso
   ```

   or paste the JSON in the console's Rules tab.
3. Set `FIREBASE_DATABASE_URL` to the database URL shown in the console.

Schema is created lazily (`schemaVersion = 1`) with collections for users/quotas, files, upload
sessions/reservations, Drive accounts + encrypted tokens, admin roles, audit logs, cleanup runs and
retries, app-version config, and notification tokens. See `src/lib/db/types.ts` for the record
shapes.

### Schema additions (backward-compatible, no migration script required)

The following nodes were added for duplicate-account protection and client API keys. Existing
data is untouched; records are back-filled lazily.

| Node | Purpose | Backfill |
|---|---|---|
| `driveIdentities/{sub:<id> \| email:<email>}` → `accountId` | Atomic uniqueness index for Google accounts | Written on the next successful connect/reconnect of each account. |
| `driveAccounts/{id}.googleAccountId`, `.normalizedEmail` | Stable identity fields | Optional; filled on next connect. Legacy records are still matched by e-mail. |
| `apiKeys/{ak_…}` | Client API key metadata (hash only) | New. |

**Manual steps after deploying this version**

1. Re-deploy `firebase/database.rules.json` (adds `driveIdentities` and `apiKeys`, both
   server-only). Without this step the Admin SDK still works (it bypasses rules), but keep the rules
   in sync.
2. Open **Drive Accounts** in the dashboard. If a *"duplicate account group detected"* banner
   appears, those records pre-date the protection. They are **not** deleted automatically: wait
   until the redundant record's files have expired (60-day TTL) or been removed, then disconnect it.
   New connections of that Google account update the primary record only.
3. No new environment variables are required. `API_SECRET_KEY` remains a server-side HMAC secret
   and is **not** a client API key — generate client keys in **Admin → API Keys**.

## 4. Scheduled cleanup (Vercel Cron)

`vercel.json` registers:

```json
{ "crons": [{ "path": "/api/v1/jobs/cleanup", "schedule": "0 0 * * *" }] }
```

Vercel invokes the endpoint with `Authorization: Bearer ${CRON_SECRET}` whenever `CRON_SECRET` is
set. Without `CRON_SECRET` the endpoint refuses unauthenticated calls. Note that **Hobby-plan cron
expressions may not run more than once a day — a schedule such as `0 */6 * * *` aborts the entire
deployment with "Hobby accounts are limited to daily cron jobs."** Cleanup therefore runs daily at
00:00 UTC on Hobby (invocation may be delayed up to ±59 min); expiry enforcement is tolerant of a
daily pass. On Pro, minute-granular schedules are honored and a more frequent cadence can be
restored in `vercel.json`. Cleanup can also be triggered manually from the dashboard
(Logs & Jobs → Run cleanup now) or via `POST /api/v1/admin/jobs/cleanup`.

## 5. Deploy

```bash
git push origin arena/36455ede-api-for-kotha-bolbo   # merge to main as usual
```

Vercel builds on push. Preview deployments get their own environment values if configured.

Post-deploy smoke test:

```bash
curl https://swkf.vercel.app/api/v1/health
curl https://swkf.vercel.app/api/v1/app/version
curl -i https://swkf.vercel.app/api/v1/storage/quota    # expect 401
```

## 6. First administrator

Either set `ADMIN_EMAILS=you@example.com` (granted once on first admin request) or run the grant
script with the service-account env vars:

```bash
FIREBASE_PROJECT_ID=kotha-bolbo-aso FIREBASE_DATABASE_URL=… \
FIREBASE_CLIENT_EMAIL=… FIREBASE_PRIVATE_KEY=… \
node scripts/admin-grant.mjs <firebase-uid> you@example.com
```

Then sign in at `https://swkf.vercel.app/admin/login`.

## 7. Local development

```bash
cp .env.example .env      # fill in real values (never commit)
npm install
npm run dev               # http://localhost:3000
npm test                  # unit tests (no credentials required)
npm run build             # production build
```

The Firebase Realtime Database *emulator* can be used locally by setting
`FIREBASE_DATABASE_EMULATOR_HOST` (the Admin SDK honors it automatically).

## 8. Security checklist (deployment)

- [x] Secrets only in Vercel env vars / secret manager; `.env` git-ignored; `.env.example` placeholders only.
- [x] Server-only vars have no client-exposure prefix; admin pages receive only the Firebase *web* config.
- [x] Firebase ID tokens verified server-side; UID derived from the verified token.
- [x] File ownership enforced on every operation; admin authorization enforced server-side.
- [x] Realtime Database rules deny all client access.
- [x] CORS restricted to `APP_BASE_URL` + `CORS_ORIGINS`; no `*` with credentials; CSRF not applicable
      (bearer tokens, no cookies for auth).
- [x] Upload-size limits and rate limits applied; scheduled endpoint protected by `CRON_SECRET`.
- [x] Google refresh tokens server-side only (optionally AES-256-GCM encrypted at rest); never
      returned to browsers or the APK.
- [x] OAuth state validated (HMAC + expiry + double-submit cookie); redirect URI fixed to
      `{APP_BASE_URL}/api/v1/admin/drive-accounts/callback`.
- [x] Logs contain request IDs and redacted metadata — never passwords, ID tokens, OAuth tokens,
      private keys, or file contents.
- [x] No end-to-end encryption is claimed: files are stored in Google Drive under the connected
      account's managed folder with private visibility.

## 9. Operational notes

- **Upload transport:** clients upload bytes directly to Google via a short-lived resumable session
  URL issued per ticket. This avoids the 4.5 MB serverless request-body limit and keeps large video
  uploads working. Downloads stream through the API after ownership checks (with Range support).
- **Drive API quota:** the app respects Google's quotas; on `403/429` provider errors the account
  is cooled down and the next eligible pool account is used. Unlimited storage is not promised.
- **Scale note:** list endpoints load metadata sets for filtering (fine to tens of thousands of
  files). For larger datasets, move listing to a SQL store — the `Store` interface isolates this.
