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
  return dataResponse(updated);
}, { auth: "admin" });

export const DELETE = apiRoute(async (ctx) => {
  const store = ctx.store!;
  const id = ctx.params.id;

  // Refuse if we have API keys tied to it (for safety)
  const keys = await store.listApiKeys();
  if (keys.some((k) => k.appId === id)) {
    throw new ApiError("CONFLICT", "Cannot delete application: it has associated API keys.");
  }

  await store.deleteApp(id);
  return dataResponse({ id, deleted: true });
}, { auth: "admin" });
