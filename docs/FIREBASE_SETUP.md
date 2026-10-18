# Firebase & Google OAuth Configuration Guide

Everything here lives in the **existing** Firebase project `kotha-bolbo-aso`. Do not create a new
project. Values are read from Vercel environment variables — nothing is hardcoded.

## 1. Firebase Authentication (user identity)

Firebase Console → **Authentication → Sign-in method**:

1. Enable **Google** (Google sign-in for end users).
2. Enable **Email/Password** (for accounts that don't use Google).
3. Existing Kotha Bolbo accounts in this project continue to work — the API accepts ID tokens from
   any user of `kotha-bolbo-aso`.

Firebase Console → **Authentication → Settings → Authorized domains**:

- Add `swkf.vercel.app`.
- Add your local dev domain (`localhost`) is pre-allowed for development.

> Firebase Google sign-in (user identity) is **separate** from the Google OAuth used to connect
> Drive storage accounts (section 3). The first authenticates app users; the second authorizes the
> server to use a Google account as storage.

## 2. Service account (server-only Admin SDK)

1. Firebase Console → Project settings → **Service accounts** → *Generate new private key*.
2. Put the JSON's `client_email` into `FIREBASE_CLIENT_EMAIL` and `private_key` into
   `FIREBASE_PRIVATE_KEY` (Vercel keeps the `\n` escapes; the app un-escapes them at runtime).
3. Keep this file out of Git. The Admin SDK must never ship in the APK or any browser bundle.

## 3. Realtime Database (persistent store)

1. Firebase Console → **Realtime Database** → create the database (choose a nearby region).
2. Start in *locked* mode, then deploy [`firebase/database.rules.json`](../firebase/database.rules.json)
   (deny-all client rules + query indexes). All access goes through the Admin SDK.
3. Copy the database URL into `FIREBASE_DATABASE_URL`.

## 4. Cloud Messaging (optional — expiry notifications)

If you want the “file expiring in 7/3 days” notifications:

1. Firebase Console → **Cloud Messaging** → note the Sender ID (`FIREBASE_MESSAGING_SENDER_ID`).
2. Clients register their FCM token via `POST /api/v1/notifications/token`.
3. If messaging or tokens are absent, notifications are recorded as `skipped` — nothing is faked.

## 5. Google Cloud — Drive storage-pool OAuth

Create (or reuse) an OAuth client for **server-side web flows**:

1. [Google Cloud Console](https://console.cloud.google.com/) → select the `kotha-bolbo-aso`
   project → **APIs & Services → Library** → enable **Google Drive API**.
2. **APIs & Services → OAuth consent screen**:
   - User type: *External* (or Internal for Workspace-only pools).
   - Scopes: add only what the app requests:
     - `https://www.googleapis.com/auth/drive.file` — files created by the app (never the rest of
       the account; this is what keeps personal-drive backups untouchable)
     - `https://www.googleapis.com/auth/userinfo.email`
     - `https://www.googleapis.com/auth/userinfo.profile`
   - Add your admin account under **Test users** while the app is in testing (refresh tokens are
     otherwise limited to 100 test users / 7-day expiry in Testing mode — move to **Production**
     after Google verification if the pool serves real traffic).
3. **APIs & Services → Credentials → Create credentials → OAuth client ID → Web application**:
   - Authorized redirect URI: `https://swkf.vercel.app/api/v1/admin/drive-accounts/callback`
   - (Local dev, optional: `http://localhost:3000/api/v1/admin/drive-accounts/callback`)
   - Copy the client ID/secret into `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET`.
4. Authorized JavaScript origins are not required (the exchange happens server-side).

### Connecting accounts

1. Sign in to `https://swkf.vercel.app/admin` as an administrator.
2. **Drive Accounts → Connect Google Drive** → choose the storage Google account → **Allow**
   (offline access is requested so the server can upload/download/delete in the background).
3. The server stores the refresh token (AES-256-GCM encrypted when `CREDENTIALS_ENCRYPTION_KEY` is
   set), creates a `Kotha Bolbo Storage` folder in that account, and runs a real create+delete
   test. The account shows **verified** only after that test passes.
4. Repeat for each pool account. Capacity is displayed only when Google reports it reliably.

### What the app will and will not do in a connected account

- **Will:** create/manage objects inside the `Kotha Bolbo Storage` folder it creates; delete only
  the exact objects it created (recorded file IDs) when they expire or are deleted.
- **Will not:** read, modify, or delete anything else in the account (the `drive.file` scope
  prevents it); create public links; expose tokens to clients.

## 6. Administrator access

Admin status is stored server-side (`admins/{uid}`) and checked on every admin request. Bootstrap
options:

- `ADMIN_EMAILS=you@example.com` — granted once (audited) when that email first calls an admin
  endpoint; or
- `node scripts/admin-grant.mjs <uid> [email]` with the service-account env vars.

## 7. Vercel OAuth/redirect checklist

| Item | Value |
|---|---|
| OAuth redirect URI | `https://swkf.vercel.app/api/v1/admin/drive-accounts/callback` |
| Firebase authorized domain | `swkf.vercel.app` |
| `APP_BASE_URL` | `https://swkf.vercel.app` (must match the redirect URI host exactly) |
| `CORS_ORIGINS` | origins of other web clients (the Android APK is unaffected) |

## 8. Verification checklist

- [ ] `GET /api/v1/health` shows `firebaseServer: configured` and `googleDriveOAuth: configured`.
- [ ] Email/password sign-in works at `/admin/login`.
- [ ] Google sign-in works at `/admin/login`.
- [ ] An invalid/expired ID token is rejected (`401 TOKEN_INVALID` / `TOKEN_EXPIRED`).
- [ ] A non-admin signed-in user receives `403` on `/api/v1/admin/*`.
- [ ] Connecting a Drive account completes and the account shows **verified** after the write test.
- [ ] Upload → confirm → download → delete works end-to-end on a real account (watch the audit log).
- [ ] `POST /api/v1/jobs/cleanup` with the wrong secret returns `401`.
