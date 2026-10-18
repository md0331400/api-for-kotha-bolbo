import type { NextRequest } from "next/server";
import { apiRoute, dataResponse } from "@/lib/api/handler";
import { ApiError } from "@/lib/errors";
import { runCleanup } from "@/lib/services/cleanup";
import { requireAdminSdk } from "@/lib/firebase-admin";
import type { AppConfig } from "@/lib/config";

/**
 * Scheduled cleanup endpoint (Vercel Cron).
 *
 * Security: accepts only
 *   1. `Authorization: Bearer <CRON_SECRET>` (Vercel Cron sends this
 *      automatically when the CRON_SECRET env var is set), or
 *   2. a valid Firebase ID token belonging to an administrator.
 * Anonymous callers are always rejected. If CRON_SECRET is not configured the
 * endpoint reports CONFIG_MISSING for unauthenticated requests.
 */

function timingSafeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function authorized(req: NextRequest, config: AppConfig | null): Promise<{ trigger: string }> {
  const header = req.headers.get("authorization") ?? "";
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  const cronSecret = config?.cronSecret;
  if (cronSecret && token && timingSafeEq(token, cronSecret)) {
    return { trigger: "cron" };
  }
  if (token) {
    try {
      const decoded = await requireAdminSdk().auth.verifyIdToken(token);
      const { getStore } = await import("@/lib/api/store-singleton");
      const store = getStore();
      if (await store.isAdmin(decoded.uid)) {
        return { trigger: `admin:${decoded.uid}` };
      }
    } catch {
      /* treated as unauthorized below */
    }
  }
  if (!cronSecret) {
    throw new ApiError(
      "CONFIG_MISSING",
      "CRON_SECRET is not configured and no administrator token was presented. Scheduled cleanup is locked.",
      { details: { missing: ["CRON_SECRET"] } }
    );
  }
  throw new ApiError("UNAUTHENTICATED", "Scheduled endpoint requires the cron secret.");
}

const handler = apiRoute(
  async (ctx) => {
    const authz = await authorized(ctx.req, ctx.config);
    const { run } = await runCleanup(ctx.store!, ctx.config!, { triggeredBy: authz.trigger });
    return dataResponse({
      runId: run.id,
      status: run.status,
      scanned: run.scanned,
      deleted: run.deleted,
      reservationReleased: run.reservationReleased,
      notified: run.notified,
      failed: run.failed,
      errors: run.errors.slice(0, 10),
    });
  },
  {
    auth: "none",
    config: "required",
    rateLimit: { limit: 12, windowSec: 60, bucket: "cleanup" },
  }
);

export async function GET(req: NextRequest, routeCtx?: { params?: Record<string, string> }) {
  return handler(req, routeCtx);
}

export async function POST(req: NextRequest, routeCtx?: { params?: Record<string, string> }) {
  return handler(req, routeCtx);
}
