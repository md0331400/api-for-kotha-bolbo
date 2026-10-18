/**
 * Regression tests for the admin dashboard API client. The Users / Files /
 * Logs pages failed because the client unwrapped `{ data, pagination }` to the
 * bare array, so `res.pagination.total` threw and the pages showed a generic
 * "Failed to load" message.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { User } from "firebase/auth";
import { api, ApiClientError, describeError } from "@/lib/admin/api-client";

const user = { getIdToken: async () => "tok" } as unknown as User;

async function failure(p: Promise<unknown>): Promise<ApiClientError> {
  try {
    await p;
  } catch (e) {
    return e as ApiClientError;
  }
  throw new Error("expected rejection");
}

function mockFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  const fn = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", ...headers },
    })
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe("admin api client", () => {
  it("getPage returns data AND pagination from the list envelope", async () => {
    const fetchFn = mockFetch(200, {
      data: [{ uid: "a" }],
      pagination: { page: 2, pageSize: 20, total: 25, totalPages: 2, hasMore: false },
    });
    const res = await api.getPage<{ uid: string }>(user, "/api/v1/admin/users?page=2");
    expect(res.data).toEqual([{ uid: "a" }]);
    expect(res.pagination.total).toBe(25);
    expect(res.pagination.totalPages).toBe(2);
    const init = fetchFn.mock.calls[0][1]!;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("getPage synthesises pagination for bare arrays and rejects non-list bodies", async () => {
    mockFetch(200, { data: [1, 2, 3] });
    const res = await api.getPage<number>(user, "/x");
    expect(res.pagination).toMatchObject({ page: 1, total: 3, totalPages: 1 });
    mockFetch(200, { data: { not: "a list" } });
    await expect(api.getPage(user, "/x")).rejects.toMatchObject({ code: "BAD_RESPONSE" });
  });

  it("get unwraps single-resource envelopes", async () => {
    mockFetch(200, { data: { runs: [], pendingRetries: 0 } });
    expect(await api.get(user, "/jobs")).toEqual({ runs: [], pendingRetries: 0 });
  });

  it("surfaces server error code, message and request id", async () => {
    mockFetch(403, { error: { code: "FORBIDDEN", message: "Administrator privileges are required.", requestId: "req-1" } });
    const err = await failure(api.get(user, "/x"));
    expect(err).toBeInstanceOf(ApiClientError);
    expect(err.status).toBe(403);
    expect(err.code).toBe("FORBIDDEN");
    expect(err.requestId).toBe("req-1");
    const ui = describeError(err, "fallback");
    expect(ui.message).toContain("Administrator privileges are required.");
    expect(ui.code).toBe("FORBIDDEN");
  });

  it("handles non-JSON responses and network failures with specific messages", async () => {
    mockFetch(502, "<html>Bad Gateway</html>", { "X-Request-Id": "rid-9" });
    const err = await failure(api.get(user, "/x"));
    expect(err.status).toBe(502);
    expect(err.requestId).toBe("rid-9");
    expect(err.message).toMatch(/HTTP 502/);

    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    const net = await failure(api.get(user, "/x"));
    expect(net.code).toBe("NETWORK_ERROR");
    expect(describeError(net, "f").message).toMatch(/Network error/);
  });

  it("describeError explains missing server configuration", () => {
    const e = new ApiClientError(503, "CONFIG_MISSING", "Missing…", { missing: ["FIREBASE_DATABASE_URL"] }, "r");
    expect(describeError(e, "f").message).toContain("FIREBASE_DATABASE_URL");
    expect(describeError(new Error("boom"), "Failed to load users.").message).toBe("Failed to load users. boom");
  });
});
