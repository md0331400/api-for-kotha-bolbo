import { Readable } from "node:stream";
import { apiRoute, ensureUser } from "@/lib/api/handler";
import { ApiError } from "@/lib/errors";
import { getDriveProvider } from "@/lib/storage/pool";

function encodeFilename(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * GET /api/v1/storage/files/:id/download
 * Streams the file from the selected Google Drive account after verifying
 * authentication and ownership (administrators may download any file).
 * Supports HTTP Range requests. No permanent provider links or credentials
 * are ever exposed.
 */
export const GET = apiRoute(
  async (ctx) => {
    const fileId = ctx.params.id;
    const auth = ctx.auth!;
    const store = ctx.store!;
    const file = await store.getFile(fileId);
    if (!file) throw new ApiError("NOT_FOUND", "File not found.");
    if (file.uid !== auth.uid && !auth.isAdmin) {
      throw new ApiError("FORBIDDEN", "This file belongs to another user.");
    }
    if (file.status === "deleted") {
      throw new ApiError("NOT_FOUND", "File has been deleted.");
    }

    const rangeHeader = ctx.req.headers.get("range");
    let range: { start: number; end?: number } | undefined;
    if (rangeHeader) {
      const m = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader.trim());
      if (m) {
        range = { start: Number(m[1]), end: m[2] ? Number(m[2]) : undefined };
      } else {
        throw new ApiError("BAD_REQUEST", "Unsupported Range header.");
      }
    }

    const provider = await getDriveProvider(store, ctx.config!, file.providerAccountId);
    const handle = await provider.download(file.providerFileId, range);

    const headers: Record<string, string> = {
      "Content-Type": handle.contentType,
      "Content-Disposition": encodeFilename(file.name),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    };
    if (handle.contentLength !== null) headers["Content-Length"] = String(handle.contentLength);
    if (range) headers["Content-Range"] = `bytes ${range.start}-${range.end ?? (handle.contentLength !== null ? range.start + handle.contentLength - 1 : "*")}/*`;

    return new Response(Readable.toWeb(handle.stream) as unknown as ReadableStream, {
      status: range ? 206 : 200,
      headers,
    });
  },
  { auth: "user", rateLimit: { limit: 60, windowSec: 60, bucket: "download" } }
);
