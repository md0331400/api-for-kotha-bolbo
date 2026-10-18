import { apiRoute, dataResponse } from "@/lib/api/handler";

export const GET = apiRoute(async (ctx) => {
  const store = ctx.store!;
  const raw = await (store as any).val("appConfig/apps") || {};
  return dataResponse(Object.values(raw));
}, { auth: "admin" });

export const POST = apiRoute(async (ctx) => {
  const store = ctx.store!;
  const body = await ctx.req.json();
  const id = "app_" + Date.now();
  const newApp = { id, name: body.name, packageName: body.packageName, status: "enabled", createdAt: Date.now() };
  await (store as any).tx("appConfig/apps/" + id, () => newApp); // Will use the patched transaction
  return dataResponse(newApp, { status: 201 });
}, { auth: "admin" });
