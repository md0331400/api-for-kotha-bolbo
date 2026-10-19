import { randomUUID } from "node:crypto";
import { z } from "zod";
import { apiRoute, dataResponse } from "@/lib/api/handler";
import { ApiError } from "@/lib/errors";
import { generateApiKey } from "@/lib/api/api-keys";
import { API_KEY_SCOPES, type ApiKeyRecord, type ApiKeyScope } from "@/lib/db/types";

const createSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(64),
  packageName: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+$/, "Invalid Android package name"),
});

function publicApp<T extends { clientApiKey?: string }>(app: T) {
  const { clientApiKey: _clientApiKey, ...safe } = app;
  return safe;
}

export const GET = apiRoute(async (ctx) => {
  const store = ctx.store!;
  const apps = await store.listApps();
  return dataResponse(apps.map(publicApp));
}, { auth: "admin" });

export const POST = apiRoute(async (ctx) => {
  const store = ctx.store!;
  let body;
  try {
    body = await ctx.req.json();
  } catch {
    body = {};
  }
  const parsed = createSchema.parse(body);

  const apps = await store.listApps();
  if (apps.some((app) => app.packageName === parsed.packageName)) {
    throw new ApiError("VALIDATION_FAILED", "Package name must be unique", {
      details: { issues: [{ path: "packageName", message: "already in use" }] },
    });
  }

  const id = "app_" + randomUUID().replace(/-/g, "");
  const generated = generateApiKey();
  const now = Date.now();
  const newApp: import("@/lib/db/types").AppRecord = {
    id,
    name: parsed.name,
    packageName: parsed.packageName,
    status: "enabled",
    createdAt: now,
    clientApiKey: generated.rawKey,
    clientApiKeyId: generated.keyId,
  };
  const keyRecord: ApiKeyRecord = {
    id: generated.keyId,
    name: `${parsed.name} SDK key`,
    subjectUid: ctx.auth!.uid,
    scopes: [...API_KEY_SCOPES] as ApiKeyScope[],
    appId: id,
    secretHash: generated.secretHash,
    prefix: generated.prefix,
    status: "active",
    createdAt: now,
    createdBy: ctx.auth!.uid,
    createdByEmail: ctx.auth!.email,
    lastUsedAt: null,
    revokedAt: null,
    revokedBy: null,
    expiresAt: null,
  };

  await store.createApp(newApp);
  try {
    await store.createApiKey(keyRecord);
    await store.appendAudit({
      actorUid: ctx.auth!.uid,
      actorEmail: ctx.auth!.email,
      action: "app.create",
      targetType: "app",
      targetId: id,
      requestId: ctx.requestId,
      details: { name: parsed.name, packageName: parsed.packageName, sdkKeyId: keyRecord.id },
    });
  } catch (error) {
    await store.deleteApp(id).catch(() => undefined);
    throw error;
  }

  return dataResponse(publicApp(newApp), { status: 201 });
}, { auth: "admin" });
