import { NextRequest, NextResponse } from "next/server";

/**
 * Edge middleware: CORS preflight handling for /api/* only.
 *
 * Route handlers do not export OPTIONS (Next.js would intercept preflight with
 * its default Allow list), so preflight is answered here. Actual responses get
 * their CORS headers from the apiRoute wrapper. Origins are limited to the app
 * origin plus explicitly configured extra origins — never `*` with credentialed
 * flows. Non-browser clients (Android APK) send no Origin and are unaffected.
 */

const SAFE_METHODS = "GET,POST,PUT,PATCH,DELETE,OPTIONS";
const SAFE_HEADERS = "Authorization,Content-Type,X-API-Key,X-Idempotency-Key,X-Request-Id";

function allowedOrigins(): Set<string> {
  const set = new Set<string>();
  const base = process.env.APP_BASE_URL?.trim();
  if (base) set.add(base);
  const extra = process.env.CORS_ORIGINS?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
  for (const o of extra) set.add(o);
  return set;
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (!pathname.startsWith("/api/")) return NextResponse.next();

  const origin = req.headers.get("origin");
  const headers = new Headers({
    "Access-Control-Allow-Methods": SAFE_METHODS,
    "Access-Control-Allow-Headers": SAFE_HEADERS,
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  });
  if (origin && allowedOrigins().has(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
  }

  if (req.method === "OPTIONS") {
    return new NextResponse(null, { status: 204, headers });
  }
  const res = NextResponse.next();
  for (const [k, v] of headers.entries()) res.headers.set(k, v);
  return res;
}

export const config = {
  matcher: ["/api/:path*"],
};
