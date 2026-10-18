import { apiRoute, dataResponse } from "@/lib/api/handler";

export const PATCH = apiRoute(async (ctx) => {
  const store = ctx.store!;
  const id = ctx.params.id;
  const body = await ctx.req.json();
  const res = await (store as any).tx("appConfig/apps/" + id, (current: any) => {
    if (!current) return undefined;
    return { ...current, ...body };
  });
  return dataResponse(res.value);
}, { auth: "admin" });

export const DELETE = apiRoute(async (ctx) => {
  const store = ctx.store!;
  const id = ctx.params.id;
  await (store as any).tx("appConfig/apps/" + id, () => null);
  return dataResponse({ id, deleted: true });
}, { auth: "admin" });
