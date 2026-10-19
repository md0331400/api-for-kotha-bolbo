import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FirebaseConfigError,
  fetchFirebaseWebConfig,
  fetchFirebaseWebConfigWithRetry,
  type FirebaseWebConfig,
} from "@/lib/admin/firebase-client";

const CONFIG: FirebaseWebConfig = {
  apiKey: "test-api-key",
  authDomain: "example.firebaseapp.com",
  databaseURL: "https://example-default-rtdb.firebaseio.com",
  projectId: "example",
  storageBucket: "example.appspot.com",
  messagingSenderId: "1234567890",
  appId: "1:1234567890:web:abcdef",
};

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function htmlResponse(): Response {
  return new Response("<!doctype html><html><body>Log in to Vercel</body></html>", {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

/** A fetch that never settles until its AbortSignal fires (models a hung request). */
function pendingUntilAborted(_input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) return; // no signal → never settles
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    signal.addEventListener("abort", () => reject(abortError()), { once: true });
  });
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchFirebaseWebConfig", () => {
  it("returns the configuration on a valid JSON success response", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        data: { firebaseWebConfigured: true, firebase: CONFIG, missingConfigGroups: [] },
      })
    );

    const result = await fetchFirebaseWebConfig();

    expect(result.configured).toBe(true);
    expect(result.config).toEqual(CONFIG);
    expect(result.missingVariables).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/app/config",
      expect.objectContaining({
        method: "GET",
        cache: "no-store",
        headers: { Accept: "application/json" },
      })
    );
  });

  it("reports a genuine missing configuration without throwing", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        data: {
          firebaseWebConfigured: false,
          firebase: null,
          missingConfigGroups: ["FIREBASE_API_KEY", "FIREBASE_APP_ID", "FIREBASE_DATABASE_URL"],
        },
      })
    );

    const result = await fetchFirebaseWebConfig();

    expect(result.configured).toBe(false);
    expect(result.config).toBeNull();
    // Only the browser-facing variables are surfaced to the client.
    expect(result.missingVariables).toEqual(["FIREBASE_API_KEY", "FIREBASE_APP_ID"]);
  });

  it("classifies an HTML login/proxy page as a non-retryable invalid response", async () => {
    fetchMock.mockResolvedValue(htmlResponse());

    await expect(fetchFirebaseWebConfig()).rejects.toBeInstanceOf(FirebaseConfigError);
    await expect(fetchFirebaseWebConfig()).rejects.toMatchObject({
      kind: "invalid-response",
      retryable: false,
    });
  });

  it("classifies a 5xx JSON response as a retryable HTTP error with its status", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { code: "INTERNAL" } }, { status: 503 }));

    await expect(fetchFirebaseWebConfig()).rejects.toMatchObject({
      name: "FirebaseConfigError",
      kind: "http",
      status: 503,
      retryable: true,
    });
  });

  it("does not retry a 401/403 deployment-protection response", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { code: "UNAUTHENTICATED" } }, { status: 401 }));

    await expect(fetchFirebaseWebConfig()).rejects.toMatchObject({
      kind: "http",
      status: 401,
      retryable: false,
    });
  });

  it("classifies a rejected fetch as a retryable network failure", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    await expect(fetchFirebaseWebConfig()).rejects.toMatchObject({
      name: "FirebaseConfigError",
      kind: "network",
      retryable: true,
    });
  });

  it("aborts a hung request after 10 seconds and classifies it as a retryable network failure", async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockImplementation(pendingUntilAborted);

      let settled = false;
      const pending = fetchFirebaseWebConfig();
      const assertion = expect(pending).rejects.toMatchObject({
        name: "FirebaseConfigError",
        kind: "network",
        retryable: true,
      });
      pending.catch(() => {
        settled = true;
      });

      // One millisecond before the timeout the request is still in flight.
      await vi.advanceTimersByTimeAsync(9_999);
      expect(settled).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // At exactly 10 s the AbortController fires and the request is classified.
      await vi.advanceTimersByTimeAsync(1);
      await assertion;
      expect(settled).toBe(true);
      await expect(pending).rejects.toThrow(/did not respond within 10 seconds/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects malformed JSON instead of treating it as missing configuration", async () => {
    fetchMock.mockResolvedValue(
      new Response("{ not json", {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );

    await expect(fetchFirebaseWebConfig()).rejects.toMatchObject({
      kind: "invalid-response",
      retryable: true,
    });
  });

  it("rejects an incomplete payload that claims Firebase is configured", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        data: { firebaseWebConfigured: true, firebase: { apiKey: "", authDomain: "", appId: "" } },
      })
    );

    await expect(fetchFirebaseWebConfig()).rejects.toMatchObject({
      kind: "invalid-response",
      retryable: true,
    });
  });
});

describe("fetchFirebaseWebConfigWithRetry", () => {
  it("retries retryable failures with exponential backoff and then succeeds", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: { code: "INTERNAL" } }, { status: 503 }))
      .mockResolvedValueOnce(jsonResponse({ error: { code: "INTERNAL" } }, { status: 502 }))
      .mockResolvedValueOnce(
        jsonResponse({ data: { firebaseWebConfigured: true, firebase: CONFIG, missingConfigGroups: [] } })
      );

    const result = await fetchFirebaseWebConfigWithRetry({ attempts: 3, baseDelayMs: 10, sleep });

    expect(result.configured).toBe(true);
    expect(result.config).toEqual(CONFIG);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([10, 20]);
  });

  it("retries a network failure before giving up", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    fetchMock
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(
        jsonResponse({ data: { firebaseWebConfigured: false, firebase: null, missingConfigGroups: [] } })
      );

    const result = await fetchFirebaseWebConfigWithRetry({ attempts: 2, baseDelayMs: 5, sleep });

    expect(result.configured).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("retries a timed-out request and succeeds on the next attempt", async () => {
    vi.useFakeTimers();
    try {
      const sleep = vi.fn(async (_ms: number) => {});
      fetchMock
        .mockImplementationOnce(pendingUntilAborted)
        .mockResolvedValueOnce(
          jsonResponse({ data: { firebaseWebConfigured: true, firebase: CONFIG, missingConfigGroups: [] } })
        );

      const pending = fetchFirebaseWebConfigWithRetry({ attempts: 2, baseDelayMs: 5, sleep });

      // First attempt hits the 10 s timeout, then the injected sleep resolves
      // immediately and the second attempt returns the configuration.
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await pending;

      expect(result.configured).toBe(true);
      expect(result.config).toEqual(CONFIG);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(sleep).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry a successful response that reports the configuration as missing", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    fetchMock.mockResolvedValue(
      jsonResponse({
        data: {
          firebaseWebConfigured: false,
          firebase: null,
          missingConfigGroups: ["FIREBASE_API_KEY"],
        },
      })
    );

    const result = await fetchFirebaseWebConfigWithRetry({ attempts: 3, baseDelayMs: 1, sleep });

    expect(result.configured).toBe(false);
    expect(result.missingVariables).toEqual(["FIREBASE_API_KEY"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("fails fast on non-retryable failures (HTML login page, 401)", async () => {
    const htmlSleep = vi.fn(async (_ms: number) => {});
    fetchMock.mockResolvedValue(htmlResponse());
    await expect(
      fetchFirebaseWebConfigWithRetry({ attempts: 3, baseDelayMs: 1, sleep: htmlSleep })
    ).rejects.toMatchObject({ kind: "invalid-response" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(htmlSleep).not.toHaveBeenCalled();
  });

  it("stops after the configured number of attempts", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    fetchMock.mockResolvedValue(jsonResponse({ error: { code: "INTERNAL" } }, { status: 500 }));

    await expect(
      fetchFirebaseWebConfigWithRetry({ attempts: 2, baseDelayMs: 1, sleep })
    ).rejects.toMatchObject({ kind: "http", status: 500, retryable: true });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });
});
