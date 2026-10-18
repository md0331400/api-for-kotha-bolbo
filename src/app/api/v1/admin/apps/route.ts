import { z } from "zod";
import { apiRoute, dataResponse } from "@/lib/api/handler";
import { ApiError } from "@/lib/errors";

const createSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(64),
  packageName: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/, "Invalid Android package name"),
});

export const GET = apiRoute(async (ctx) => {
  const store = ctx.store!;
  const apps = await store.listApps();
  return dataResponse(apps);
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

  const id = "app_" + Date.now();
  const newApp: import("@/lib/db/types").AppRecord = { id, name: parsed.name, packageName: parsed.packageName, status: "enabled", createdAt: Date.now() };
  await store.createApp(newApp);
  return dataResponse(newApp, { status: 201 });
}, { auth: "admin" });
