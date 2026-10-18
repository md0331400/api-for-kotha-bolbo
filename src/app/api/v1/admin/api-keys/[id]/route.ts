import { z } from "zod";
import { apiRoute, dataResponse } from "@/lib/api/handler";
import { publicApiKey } from "@/lib/api/api-keys";
import { ApiError } from "@/lib/errors";
import { parseOrThrow } from "@/lib/validation";

const patchSchema = z.object({ action: z.enum(["revoke"]) }).strict();

async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

/**
 * PATCH /api/v1/admin/api-keys/:id   { "action": "revoke" }
 * Revocation is immediate and irreversible (idempotent).
 */
export const PATCH = apiRoute(
  async (ctx) => {
    const store = ctx.store!;
    const body = parseOrThrow(patchSchema, await readJson(ctx.req));
    const key = await store.getApiKey(ctx.params.id);
    if (!key) throw new ApiError("NOT_FOUND", "API key not found.");
    if (body.action === "revoke" && key.status === "active") {
      await store.updateApiKey(key.id, { status: "revoked", revokedAt: Date.now(), revokedBy: ctx.auth!.uid });
      await store.appendAudit({
        actorUid: ctx.auth!.uid,
        actorEmail: ctx.auth!.email,
        action: "apikey.revoke",
        targetType: "api_key",
        targetId: key.id,
        requestId: ctx.requestId,
        details: { name: key.name, subjectUid: key.subjectUid },
      });
    }
    const updated = await store.getApiKey(key.id);
    return dataResponse(publicApiKey(updated!));
  },
  { auth: "admin", rateLimit: { limit: 30, windowSec: 3600, bucket: "apikey-manage" } }
);

/**
 * DELETE /api/v1/admin/api-keys/:id
 * Removes metadata of an already-revoked key. Active keys must be revoked
 * first; the revoke/delete audit trail is preserved in auditLogs.
 */
export const DELETE = apiRoute(
  async (ctx) => {
    const store = ctx.store!;
    const key = await store.getApiKey(ctx.params.id);
    if (!key) throw new ApiError("NOT_FOUND", "API key not found.");
    if (key.status !== "revoked") {
      throw new ApiError("CONFLICT", "Revoke the key before deleting its metadata.");
    }
    await store.deleteApiKey(key.id);
    await store.appendAudit({
      actorUid: ctx.auth!.uid,
      actorEmail: ctx.auth!.email,
      action: "apikey.delete",
      targetType: "api_key",
      targetId: key.id,
      requestId: ctx.requestId,
      details: { name: key.name, subjectUid: key.subjectUid, createdAt: key.createdAt, revokedAt: key.revokedAt },
    });
    return dataResponse({ id: key.id, deleted: true });
  },
  { auth: "admin", rateLimit: { limit: 30, windowSec: 3600, bucket: "apikey-manage" } }
);
