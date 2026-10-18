# Kotha Bolbo Storage API — Reference

Base URL (production): `https://swkf.vercel.app`  
API root: `https://swkf.vercel.app/api/v1`

All request and response bodies are JSON (`Content-Type: application/json`) except file downloads
(binary streams). Timestamps are ISO-8601 UTC strings.

## Authentication

Protected endpoints require a **Firebase ID token**:

```
Authorization: Bearer <firebase-id-token>
```

The server verifies the token with the Firebase Admin SDK and derives the user's UID from the
verified token. A UID in a request body is never trusted. Tokens expire (default 1 hour) — clients
must refresh them via the Firebase SDK.

Admin endpoints additionally require the caller to be an administrator **on the server**
(`admins/{uid}` record, or the `ADMIN_EMAILS` bootstrap list).

## Response envelopes

Success (single resource):

```json
{ "data": { "...": "..." } }
```

Success (list):

```json
{
  "data": [{ "...": "..." }],
  "pagination": { "page": 1, "pageSize": 20, "total": 0, "totalPages": 1, "hasMore": false }
}
```

Error (never contains stack traces, tokens, or secrets):

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Input validation failed.",
    "requestId": "0f8c…",
    "details": { "issues": [{ "path": "sizeBytes", "message": "…" }] }
  }
}
```

Every response carries `X-Request-Id` (also echoed in `error.requestId`) — quote it in support
requests. Status codes: `400` bad request, `401` unauthenticated, `403` forbidden, `404` not found,
`409` conflict/duplicate, `410` upload ticket expired, `413` too large / quota exceeded, `422`
validation failed, `429` rate limited, `502`/`503` provider or configuration problems.

Error codes: `BAD_REQUEST`, `VALIDATION_FAILED`, `UNAUTHENTICATED`, `TOKEN_INVALID`, `TOKEN_EXPIRED`,
`FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `DUPLICATE`, `QUOTA_EXCEEDED`, `PAYLOAD_TOO_LARGE`,
`RATE_LIMITED`, `CONFIG_MISSING`, `PROVIDER_ERROR`, `PROVIDER_UNAVAILABLE`, `UPLOAD_TICKET_EXPIRED`,
`UPLOAD_NOT_CONFIRMED`, `INTERNAL`.

## Rate limits

Per authenticated UID (or client IP for public routes), fixed 60-second windows:

| Class | Limit / min |
|---|---|
| General | 120 |
| Upload ticket | 30 |
| Upload confirm | 60 |
| Download | 60 |
| File listing | 120 |
| Admin | 240 |
| Cleanup job | 12 |

Exceeding a limit returns `429 RATE_LIMITED` with `details.retryAfterSec`.

---

## General

### `GET /api/v1/health`

Public. No secrets.

```http
GET /api/v1/health
```

```json
{
  "status": "ok",
  "service": "kotha-bolbo-storage-api",
  "version": "1.0.0",
  "time": "2026-10-18T18:19:32.485Z",
  "requestId": "…",
  "checks": {
    "firebaseServer": "configured",
    "googleDriveOAuth": "configured"
  }
}
```

`status` is `degraded` when server configuration is missing; `checks.missingConfigGroups` then lists
the **names** of missing variables (never values).

### `GET /api/v1/app/version`

Public. Published app-version metadata for the APK/website update flow.

```json
{
  "data": {
    "isPublished": true,
    "currentVersion": "1.2.0",
    "minSupportedVersion": "1.0.0",
    "updateUrl": "https://example.com/apk",
    "forceUpdate": false,
    "releaseNotes": "…",
    "publishedAt": "2026-10-18T12:00:00.000Z"
  }
}
```

Before an administrator publishes anything, `isPublished` is `false` and all values are `null`
(no fabricated defaults).

### `GET /api/v1/app/config`

Public. Client-safe Firebase *web* configuration used by the admin login page. Never includes
Admin SDK credentials.

---

## Storage (authenticated)

### `GET /api/v1/storage/quota`

```json
{
  "data": {
    "quotaBytes": 2147483648,
    "usedBytes": 0,
    "reservedBytes": 0,
    "remainingBytes": 2147483648,
    "fileCount": 0,
    "restricted": false,
    "categories": { "chat": 0, "voice": 0, "photo": 0, "video": 0, "other": 0 },
    "categoryBytes": { "chat": 0, "voice": 0, "photo": 0, "video": 0, "other": 0 }
  }
}
```

Default quota is **2 GiB (2,147,483,648 bytes)** per user. All figures derive from confirmed file
records and active reservations.

### `GET /api/v1/storage/files`

Paginated list of the caller's files. Query parameters:

| Parameter | Values |
|---|---|
| `category` | `chat` \| `voice` \| `photo` \| `video` \| `other` |
| `status` | `pending_delete` \| `confirmed` \| `deleted` \| `delete_failed` (default `confirmed`) |
| `expiringInDays` | 1–365 — files expiring within N days |
| `createdAfter` / `createdBefore` | epoch ms |
| `q` | substring of id/name |
| `page`, `pageSize` | default 1, 20 (max 100) |
| `sort` | `createdAt` \| `expiresAt` \| `sizeBytes` |
| `order` | `asc` \| `desc` |

```json
{
  "data": [
    {
      "id": "file_9x…",
      "category": "photo",
      "name": "cat.png",
      "mimeType": "image/png",
      "sizeBytes": 100,
      "createdAt": "2026-10-18T18:20:00.000Z",
      "expiresAt": "2026-12-17T18:20:00.000Z",
      "status": "confirmed",
      "daysUntilExpiry": 60
    }
  ],
  "pagination": { "page": 1, "pageSize": 20, "total": 1, "totalPages": 1, "hasMore": false }
}
```

### `POST /api/v1/storage/upload-ticket`

Validates an upload, **reserves quota**, and selects a Google Drive account. Request:

```json
{
  "category": "photo",
  "name": "cat.png",
  "mimeType": "image/png",
  "sizeBytes": 1048576,
  "idempotencyKey": "a1b2c3d4e5f6g7h8"
}
```

- `idempotencyKey` (8–128 chars, `[A-Za-z0-9_~-]`) makes retries safe: the same key returns the same
  ticket without double-reserving quota.
- `name` must not contain path separators or control characters.
- `mimeType` must fit `category` (e.g. `audio/*` for `voice`).
- `sizeBytes` must be > 0 and ≤ `MAX_UPLOAD_BYTES`.

Response:

```json
{
  "data": {
    "uploadId": "up_…",
    "status": "reserved",
    "fileId": "file_…",
    "category": "photo",
    "name": "cat.png",
    "mimeType": "image/png",
    "expectedBytes": 1048576,
    "reservedBytes": 1048576,
    "createdAt": "…",
    "ticketExpiresAt": "…",
    "upload": {
      "provider": "google-drive",
      "method": "PUT",
      "url": "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&…",
      "headers": {
        "Content-Type": "image/png",
        "X-Upload-Content-Length": "1048576"
      },
      "expiresAt": "…"
    },
    "reused": false
  }
}
```

**A successful ticket is not a successful upload.** The client must now transfer the bytes:

```bash
curl -X PUT \
  -H "Content-Type: image/png" \
  -H "X-Upload-Content-Length: 1048576" \
  --data-binary @cat.png \
  "<upload.url>"
```

The `upload.url` is a short-lived, single-object Google resumable session created by the server on
the selected pool account. It is not a permanent credential and cannot touch anything else.

Errors: `413 PAYLOAD_TOO_LARGE` (over `MAX_UPLOAD_BYTES`), `413 QUOTA_EXCEEDED` (over quota),
`403 FORBIDDEN` (restricted), `422 VALIDATION_FAILED`, `503 PROVIDER_UNAVAILABLE` (no eligible
Drive account; the reservation is released automatically).

### `POST /api/v1/storage/upload-confirm`

Verifies the uploaded object with the provider and finalizes metadata + quota.

```json
{
  "uploadId": "up_…",
  "providerFileId": "1A2B3C…"
}
```

`providerFileId` is the file id returned by Google in the resumable-upload response body. The
server independently verifies: object exists, lives in the managed app folder, real size ≤
reserved size (quota is charged the **verified** size), creation time ≥ ticket creation, and the
provider object is not already registered (single-claim). Response:

```json
{
  "data": {
    "file": {
      "id": "file_…",
      "category": "photo",
      "name": "cat.png",
      "mimeType": "image/png",
      "sizeBytes": 1048576,
      "createdAt": "…",
      "expiresAt": "2026-12-17T18:20:00.000Z",
      "status": "confirmed",
      "daysUntilExpiry": 60
    },
    "reused": false,
    "uploadId": "up_…"
  }
}
```

Idempotent: confirming again returns the same file with `"reused": true`. Errors:
`400 BAD_REQUEST` (object larger than reserved), `409 UPLOAD_NOT_CONFIRMED` (missing object / wrong
folder / session released), `409 DUPLICATE` (provider object already registered), `410
UPLOAD_TICKET_EXPIRED` (confirm window elapsed; the orphan object is removed by cleanup).

### `GET /api/v1/storage/files/:id`

File metadata. Owner or administrator only (`403` otherwise).

### `GET /api/v1/storage/files/:id/download`

Streams the file from its Drive account after ownership verification. Supports HTTP `Range`
requests (`206 Partial Content`). Response headers include `Content-Disposition: attachment`.
No Google links or credentials are exposed.

### `DELETE /api/v1/storage/files/:id`

Deletes the provider object and releases quota. Idempotent (`alreadyDeleted: true` on repeat).
Owner or administrator only.

### `POST /api/v1/notifications/token`

Optional FCM device-token registration for expiry notifications.

```json
{ "token": "<fcm-registration-token>", "platform": "android" }
```

---

## Admin API (administrator only)

All admin endpoints require an admin-verified ID token and write audit records for mutations.

### `GET /api/v1/admin/session`
Caller identity + `isAdmin` (used by the dashboard).

### `GET /api/v1/admin/stats`
Overview aggregates: users, files, bytes, Drive account states, expiring-soon count, failed
uploads, last cleanup run, retry-queue depth. Everything reflects the database (zeros when empty).

### Google Drive accounts

| Endpoint | Description |
|---|---|
| `GET /api/v1/admin/drive-accounts` | List accounts: status, verified flag, last success/error, file count, capacity (only when the provider reports it). **Never returns tokens.** |
| `GET /api/v1/admin/drive-accounts/connect` | Returns a Google OAuth `authorizeUrl` (offline access, minimal scopes). Sets a one-time state cookie. |
| `GET /api/v1/admin/drive-accounts/callback` | Google's redirect target (browser). Validates signed state, exchanges the code server-side, stores the refresh token (encrypted when `CREDENTIALS_ENCRYPTION_KEY` is set), provisions the managed folder, and runs a **real write test** before showing the account as verified. |
| `PATCH /api/v1/admin/drive-accounts/:id` | `{ "action": "enable" \| "disable" \| "retry", "reason": "…" }` |
| `POST /api/v1/admin/drive-accounts/:id/test` | Real create+delete connectivity test; refreshes capacity info. |
| `DELETE /api/v1/admin/drive-accounts/:id?confirm=DISCONNECT` | Destroys stored credentials. Does not touch the Google account's contents. |

### Users

| Endpoint | Description |
|---|---|
| `GET /api/v1/admin/users?q=&page=&pageSize=` | Search by UID/email/display name. |
| `GET /api/v1/admin/users/:uid` | Usage, quota, file count, files expiring within 7 days. |
| `PATCH /api/v1/admin/users/:uid` | `{ "quotaBytes": 1073741824 }` and/or `{ "restricted": true }` — audited. |
| `DELETE /api/v1/admin/users/:uid/files?confirm=DELETE` | Queues deletion of the user's files (processed by cleanup). |

### Files

| Endpoint | Description |
|---|---|
| `GET /api/v1/admin/files?uid=&category=&status=&expiringInDays=&q=` | Paginated list with provider assignment and deletion state. |
| `DELETE /api/v1/admin/files/:id?confirm=1` | Audited deletion with real provider removal. |

### App version

| Endpoint | Description |
|---|---|
| `GET /api/v1/admin/app-version` | Current configuration (or unpublished). |
| `PUT /api/v1/admin/app-version` | Publish `{ currentVersion, minSupportedVersion, updateUrl, forceUpdate, releaseNotes }` — validated (semver, https URL), audited. |

### Logs & jobs

| Endpoint | Description |
|---|---|
| `GET /api/v1/admin/audit-logs?action=&actorUid=&page=` | Administrator action history (no secrets). |
| `GET /api/v1/admin/jobs/cleanup` | Cleanup runs + retry-queue depth. |
| `POST /api/v1/admin/jobs/cleanup` | Trigger a cleanup run now (audited). |

---

## Scheduled cleanup (cron)

```
POST|GET /api/v1/jobs/cleanup
Authorization: Bearer <CRON_SECRET>
```

Configured as a Vercel Cron Job (default every 6 hours — see `vercel.json`). Accepts **only** the
`CRON_SECRET` bearer (Vercel Cron sends it automatically) or an admin ID token. Anonymous calls are
rejected. Each run:

1. Releases reservations for abandoned/expired upload tickets (and removes orphaned provider
   objects created without confirm).
2. Deletes files whose `expiresAt` (60 days after upload) has passed — from the correct Drive
   account, only the exact recorded object, only when it is inside the managed app folder.
3. Processes the retry queue with exponential backoff; permanent failures are logged after 8
   attempts (`delete_failed`).
4. Processes admin-queued deletions.
5. Sends expiry notifications (~7 and ~3 days before) when FCM + device tokens exist.
6. Reconciles per-user usage counters from authoritative records (self-healing).

The run summary is stored as a `cleanupRuns` record and visible in the dashboard.

---

## Example session (curl)

```bash
# 1. Quota (real zeros before any upload)
curl -H "Authorization: Bearer $ID_TOKEN" https://swkf.vercel.app/api/v1/storage/quota

# 2. Ticket
curl -X POST -H "Authorization: Bearer $ID_TOKEN" -H "Content-Type: application/json" \
  -d '{"category":"voice","name":"note.ogg","mimeType":"audio/ogg","sizeBytes":2048,"idempotencyKey":"key-2026-0001"}' \
  https://swkf.vercel.app/api/v1/storage/upload-ticket

# 3. Direct upload to Google (URL from the ticket response)
curl -X PUT -H "Content-Type: audio/ogg" -H "X-Upload-Content-Length: 2048" \
  --data-binary @note.ogg "$UPLOAD_URL"

# 4. Confirm
curl -X POST -H "Authorization: Bearer $ID_TOKEN" -H "Content-Type: application/json" \
  -d '{"uploadId":"up_…","providerFileId":"1A2B…"}' \
  https://swkf.vercel.app/api/v1/storage/upload-confirm

# 5. List / download / delete
curl -H "Authorization: Bearer $ID_TOKEN" https://swkf.vercel.app/api/v1/storage/files
curl -H "Authorization: Bearer $ID_TOKEN" -OJ https://swkf.vercel.app/api/v1/storage/files/file_…/download
curl -X DELETE -H "Authorization: Bearer $ID_TOKEN" https://swkf.vercel.app/api/v1/storage/files/file_…
```
