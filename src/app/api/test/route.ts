import { NextResponse } from "next/server";

export async function GET() {
  const res = NextResponse.json({ test: "ok" });
  return new Response(res.body, { status: res.status, headers: res.headers });
}
