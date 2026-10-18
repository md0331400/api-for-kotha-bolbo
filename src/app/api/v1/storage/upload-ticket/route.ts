import { apiRoute, dataResponse, ensureUser } from "@/lib/api/handler";
import { parseOrThrow, uploadTicketSchema, isMimeAllowedForCategory } from "@/lib/validation";
import { ApiError, isApiError } from "@/lib/errors";
import { createResumableOnPool } from "@/lib/storage/pool";

async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new ApiError("BAD_REQUEST", "Request body must be JSON.");
  }
}

/**
 * POST /api/v1/storage/upload-ticket
 *
 * Validates an upload request, reserves quota, and selects a Google Drive
 * storage account. The response carries a **short-lived resumable upload
 * session URL** for direct-to-provider transfer (the Vercel request-body limit
 * makes proxying large files impractical). The upload is NOT complete until
 * `POST /api/v1/storage/upload-confirm` succeeds.
 */
export const POST = apiRoute(
  async (ctx) => {
    const body = parseOrThrow(uploadTicketSchema, await readJson(ctx.req));
    const config = ctx.config!;
    const store = ctx.store!;
    const user = await ensureUser(ctx);

    if (body.sizeBytes > config.maxUploadBytes) {
      throw new ApiError("PAYLOAD_TOO_LARGE", `Upload exceeds the per-file limit of ${config.maxUploadBytes} bytes.`, {
        details: { maxUploadBytes: config.maxUploadBytes, requestedBytes: body.sizeBytes },
      });
    }
    if (!isMimeAllowedForCategory(body.category, body.mimeType)) {
      throw new ApiError("VALIDATION_FAILED", `MIME type "${body.mimeType}" is not allowed for category "${body.category}".`, {
        details: { category: body.category, mimeType: body.mimeType },
      });
    }

    const { session, reused } = await store.createUploadSession({
      uid: user.uid,
      category: body.category,
      name: body.name,
      mimeType: body.mimeType,
      expectedBytes: body.sizeBytes,
      idempotencyKey: body.idempotencyKey,
      ticketTtlMs: config.uploadTicketTtlMinutes * 60_000,
      defaultQuotaBytes: config.defaultUserQuotaBytes,
      appId: ctx.auth!.appId,
    });

    // Idempotent replay: return the existing ticket (including its provider URL).
    if (reused && session.providerSessionUrl && session.status === "reserved") {
      return dataResponse({
        uploadId: session.id,
        status: session.status,
        fileId: session.fileId,
        category: session.category,
        name: session.name,
        mimeType: session.mimeType,
        expectedBytes: session.expectedBytes,
        reservedBytes: session.reservedBytes,
        createdAt: new Date(session.createdAt).toISOString(),
        ticketExpiresAt: new Date(session.ticketExpiresAt).toISOString(),
        upload: {
          provider: "google-drive",
          method: "PUT",
          url: session.providerSessionUrl,
          headers: { "Content-Type": session.mimeType, "X-Upload-Content-Length": String(session.expectedBytes) },
          expiresAt: new Date(session.ticketExpiresAt).toISOString(),
        },
        reused: true,
      });
    }
    if (reused && session.status === "confirmed") {
      throw new ApiError("CONFLICT", "This upload was already confirmed. Use the file resource instead.", {
        details: { uploadId: session.id, fileId: session.fileId },
      });
    }

    // Reserve quota first, then assign a provider (fail → release reservation).
    let assignment;
    try {
      const appId = ctx.auth!.appId;
    if (!appId) {
      throw new ApiError("FORBIDDEN", "An application identity (X-API-Key) is required to access storage.", {
        details: { hint: "Include a valid X-API-Key header associated with a registered application." },
      });
    }
    assignment = await createResumableOnPool(store, config, {
        appId,
        uid: user.uid,
        category: body.category,
        name: body.name,
        mimeType: body.mimeType,
        sizeBytes: body.sizeBytes,
      });
    } catch (e) {
      await store.releaseUploadReservation(session.id, "PROVIDER_UNAVAILABLE");
      throw e;
    }
    await store.assignUploadProvider(session.id, {
      providerAccountId: assignment.accountId,
      providerSessionUrl: assignment.uploadUrl,
    });

    return dataResponse({
      uploadId: session.id,
      status: "reserved",
      fileId: session.fileId,
      category: session.category,
      name: session.name,
      mimeType: session.mimeType,
      expectedBytes: session.expectedBytes,
      reservedBytes: session.reservedBytes,
      createdAt: new Date(session.createdAt).toISOString(),
      ticketExpiresAt: new Date(session.ticketExpiresAt).toISOString(),
      upload: {
        provider: "google-drive",
        method: "PUT",
        url: assignment.uploadUrl,
        headers: assignment.headers,
        expiresAt: new Date(assignment.expiresAt).toISOString(),
      },
      reused: false,
    });
  },
  { auth: "user", scope: "storage:write", rateLimit: { limit: 30, windowSec: 60, bucket: "upload-ticket" } }
);
