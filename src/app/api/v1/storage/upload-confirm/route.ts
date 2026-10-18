import { apiRoute, dataResponse, ensureUser } from "@/lib/api/handler";
import { parseOrThrow, uploadConfirmSchema } from "@/lib/validation";
import { ApiError } from "@/lib/errors";
import { toPublicFile } from "@/lib/db/types";
import { getDriveProvider } from "@/lib/storage/pool";
import { logger } from "@/lib/logger";

async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new ApiError("BAD_REQUEST", "Request body must be JSON.");
  }
}

const CONFIRM_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * POST /api/v1/storage/upload-confirm
 *
 * Verifies the uploaded object with the provider (existence, managed folder,
 * real size, creation time) and finalizes metadata + quota. Idempotent: a
 * repeated confirm for the same session returns the same file record.
 */
export const POST = apiRoute(
  async (ctx) => {
    const body = parseOrThrow(uploadConfirmSchema, await readJson(ctx.req));
    const config = ctx.config!;
    const store = ctx.store!;
    const user = await ensureUser(ctx);

    const session = await store.getUploadSession(body.uploadId);
    if (!session) throw new ApiError("NOT_FOUND", "Upload session not found.");
    if (session.uid !== user.uid) {
      throw new ApiError("FORBIDDEN", "Upload session belongs to another user.");
    }

    if (session.status === "confirmed" && session.fileId) {
      const existing = await store.getFile(session.fileId);
      if (existing) {
        return dataResponse({
          file: toPublicFile(existing),
          reused: true,
          uploadId: session.id,
        });
      }
    }
    if (session.status === "released" || session.status === "failed") {
      throw new ApiError("UPLOAD_NOT_CONFIRMED", "Upload session is no longer active (expired or released).", {
        details: { uploadId: session.id, status: session.status },
      });
    }
    if (Date.now() > session.ticketExpiresAt + CONFIRM_GRACE_MS) {
      await store.releaseUploadReservation(session.id, "CONFIRM_WINDOW_EXPIRED");
      throw new ApiError("UPLOAD_TICKET_EXPIRED", "Upload ticket expired before confirmation.");
    }
    if (!session.providerAccountId) {
      throw new ApiError("UPLOAD_NOT_CONFIRMED", "Upload session has no provider assignment.");
    }

    const providerFileId = body.providerFileId ?? session.providerFileId;
    if (!providerFileId) {
      throw new ApiError("BAD_REQUEST", "providerFileId is required (returned by the provider after upload).");
    }

    // Server-side verification of the provider object.
    const account = await store.getDriveAccount(session.providerAccountId);
    const provider = await getDriveProvider(store, config, session.providerAccountId);
    const meta = await provider.getFileMeta(providerFileId);
    if (!meta || meta.trashed) {
      throw new ApiError("UPLOAD_NOT_CONFIRMED", "Uploaded object was not found at the provider.");
    }
    if (account?.managedFolderId && meta.parents.length && !meta.parents.includes(account.managedFolderId)) {
      throw new ApiError("UPLOAD_NOT_CONFIRMED", "Uploaded object is not in the managed storage folder.");
    }
    if (meta.sizeBytes <= 0) {
      throw new ApiError("UPLOAD_NOT_CONFIRMED", "Uploaded object is empty.");
    }
    if (meta.sizeBytes > session.expectedBytes) {
      await store.releaseUploadReservation(session.id, "SIZE_MISMATCH");
      throw new ApiError("BAD_REQUEST", "Uploaded object is larger than the reserved size.", {
        details: { expectedBytes: session.expectedBytes, actualBytes: meta.sizeBytes },
      });
    }
    if (meta.createdTime !== null && meta.createdTime < session.createdAt - 5 * 60_000) {
      throw new ApiError("UPLOAD_NOT_CONFIRMED", "Uploaded object predates the upload ticket.");
    }

    await store.markUploadUploaded(session.id, providerFileId);
    const { file, reused } = await store.confirmUpload({
      uploadId: session.id,
      uid: user.uid,
      providerFileId,
      verifiedName: meta.name,
      verifiedMimeType: meta.mimeType,
      verifiedSizeBytes: meta.sizeBytes,
      verifiedParents: meta.parents,
      managedFolderId: account?.managedFolderId ?? null,
      verifiedCreatedTime: meta.createdTime,
      ttlDays: config.fileTtlDays,
    });

    logger.info("upload.confirmed", {
      fileId: file.id,
      uid: user.uid,
      sizeBytes: file.sizeBytes,
      category: file.category,
    });

    return dataResponse({
      file: toPublicFile(file),
      reused,
      uploadId: session.id,
    });
  },
  { auth: "user", rateLimit: { limit: 60, windowSec: 60, bucket: "upload-confirm" } }
);
