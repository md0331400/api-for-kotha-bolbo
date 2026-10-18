import { z } from "zod";
import { apiRoute, dataResponse } from "@/lib/api/handler";
import { generateApiKey, publicApiKey } from "@/lib/api/api-keys";
import { ApiError } from "@/lib/errors";
import { parseOrThrow } from "@/lib/validation";
import { requireAdminSdk } from "@/lib/firebase-admin";
import { API_KEY_SCOPES, type ApiKeyRecord, type ApiKeyScope } from "@/lib/db/types";
import { logger } from "@/lib/logger";

const createSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "name is required")
      .max(64)
      .regex(/^[\p{L}\p{N} _.:()\-/]+$/u, "name contains unsupported characters"),
    subjectUid: z.string().trim().min(1, "subjectUid is required").max(128),
    scopes: z
      .array(z.enum(API_KEY_SCOPES))
      .min(1, "select at least one scope")
      .max(API_KEY_SCOPES.length)
      .transform((arr) => Array.from(new Set(arr)) as ApiKeyScope[]),
    expiresInDays: z.number().int().min(1).max(3650).nullable().optional(),
  })
  .strict();

async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

/**
 * The subject must be a real Firebase user (or an existing user record) so a
 * key can never be minted for a fabricated identity.
 */
async function assertSubjectExists(uid: string, storeHas: boolean): Promise<void> {
  if (storeHas) return;
  const auth = requireAdminSdk().auth as { getUser?: (uid: string) => Promise<unknown> };
  if (typeof auth.getUser !== "function") {
    throw new ApiError("VALIDATION_FAILED", "Subject user not found.", {
      details: { issues: [{ path: "subjectUid", message: "no such user record" }] },
    });
  }
  try {
    await auth.getUser(uid);
  } catch (e) {
    const code = (e as { code?: string })?.code ?? "";
    if (code.includes("user-not-found") || code.includes("invalid")) {
      throw new ApiError("VALIDATION_FAILED", "Subject user not found in Firebase Authentication.", {
        details: { issues: [{ path: "subjectUid", message: "no such Firebase user" }] },
      });
    }
    throw new ApiError("PROVIDER_ERROR", "Could not verify the subject user with Firebase Authentication.");
  }
}

/**
 * GET /api/v1/admin/api-keys
 * Lists client API keys (masked; never the secret or its hash).
 */
export const GET = apiRoute(
  async (ctx) => {
    const keys = await ctx.store!.listApiKeys();
    return dataResponse(keys.map(publicApiKey));
  },
  { auth: "admin", rateLimit: { limit: 240, windowSec: 60, bucket: "admin" } }
);

/**
 * POST /api/v1/admin/api-keys
 * Creates a key. The raw key is returned exactly once in this response and is
 * never stored or logged. Creation is rate limited per administrator.
 */
export const POST = apiRoute(
  async (ctx) => {
    const store = ctx.store!;
    const body = parseOrThrow(createSchema, await readJson(ctx.req));

    const existingUser = await store.getUser(body.subjectUid);
    await assertSubjectExists(body.subjectUid, Boolean(existingUser));

    const generated = generateApiKey();
    const now = Date.now();
    const rec: ApiKeyRecord = {
      id: generated.keyId,
      name: body.name,
      subjectUid: body.subjectUid,
      scopes: body.scopes,
      secretHash: generated.secretHash,
      prefix: generated.prefix,
      status: "active",
      createdAt: now,
      createdBy: ctx.auth!.uid,
      createdByEmail: ctx.auth!.email,
      lastUsedAt: null,
      revokedAt: null,
      revokedBy: null,
      expiresAt: body.expiresInDays ? now + body.expiresInDays * 86_400_000 : null,
    };
    await store.createApiKey(rec);
    await store.appendAudit({
      actorUid: ctx.auth!.uid,
      actorEmail: ctx.auth!.email,
      action: "apikey.create",
      targetType: "api_key",
      targetId: rec.id,
      requestId: ctx.requestId,
      details: { name: rec.name, subjectUid: rec.subjectUid, scopes: rec.scopes, expiresAt: rec.expiresAt },
    });
    logger.info("apikey.created", { credentialId: rec.id, requestId: ctx.requestId });
    return dataResponse({ key: publicApiKey(rec), rawKey: generated.rawKey }, { status: 201 });
  },
  { auth: "admin", rateLimit: { limit: 10, windowSec: 3600, bucket: "apikey-create" } }
);
