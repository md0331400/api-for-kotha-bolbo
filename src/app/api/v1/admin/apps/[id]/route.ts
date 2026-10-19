import { z } from "zod";
import { apiRoute, dataResponse } from "@/lib/api/handler";
import { ApiError } from "@/lib/errors";

const patchSchema = z.object({
  name: z.string().trim().min(1).max(64).optional(),
  packageName: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/, "Invalid Android package name")
    .optional(),
  status: z.enum(["enabled", "disabled"]).optional(),
});

export const PATCH = apiRoute(async (ctx) => {
  const store = ctx.store!;
  const id = ctx.params.id;
  let body;
  try {
    body = await ctx.req.json();
  } catch {
    body = {};
  }
  const parsed = patchSchema.parse(body);

  if (parsed.packageName) {
    const apps = await store.listApps();
    if (apps.some((app) => app.id !== id && app.packageName === parsed.packageName)) {
      throw new ApiError("VALIDATION_FAILED", "Package name must be unique", {
        details: { issues: [{ path: "packageName", message: "already in use" }] },
      });
    }
  }

  const updated = await store.updateApp(id, parsed);
  if (!updated) throw new ApiError("NOT_FOUND", "Application not found");
  const { clientApiKey: _clientApiKey, ...safeApp } = updated;
  return dataResponse(safeApp);
}, { auth: "admin" });

export const DELETE = apiRoute(async (ctx) => {
  const store = ctx.store!;
  const id = ctx.params.id;
  const app = await store.getApp(id);
  if (!app) throw new ApiError("NOT_FOUND", "Application not found.");

  const keys = await store.listApiKeys();
  const associated = keys.filter((key) => key.appId === id);
  const unrelatedKeys = associated.filter((key) => key.id !== app.clientApiKeyId);
  if (unrelatedKeys.length) {
    throw new ApiError("CONFLICT", "Cannot delete application while separately issued API keys are attached. Revoke or remove those keys first.");
  }

  if (app.clientApiKeyId && associated.some((key) => key.id === app.clientApiKeyId)) {
    const key = associated.find((item) => item.id === app.clientApiKeyId)!;
    await store.updateApiKey(key.id, {
      status: "revoked",
      revokedAt: Date.now(),
      revokedBy: ctx.auth!.uid,
    });
    await store.appendAudit({
      actorUid: ctx.auth!.uid,
      actorEmail: ctx.auth!.email,
      action: "apikey.revoke",
      targetType: "api_key",
      targetId: key.id,
      requestId: ctx.requestId,
      details: { name: key.name, subjectUid: key.subjectUid, reason: "application deleted" },
    });
    await store.deleteApiKey(key.id);
  }

  await store.deleteApp(id);
  await store.appendAudit({
    actorUid: ctx.auth!.uid,
    actorEmail: ctx.auth!.email,
    action: "app.delete",
    targetType: "app",
    targetId: id,
    requestId: ctx.requestId,
    details: { name: app.name, packageName: app.packageName },
  });
  return dataResponse({ id, deleted: true });
}, { auth: "admin" });
