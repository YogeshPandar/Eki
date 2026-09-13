import { afterEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { handlePlaceSearch } from "./places";

interface ResponseRecorder {
  response: Response;
  statusCode: () => number;
  body: () => unknown;
}

function responseRecorder(): ResponseRecorder {
  let statusCode = 200;
  let body: unknown;
  const response = {
    status(code: number) {
      statusCode = code;
      return response;
    },
    json(value: unknown) {
      body = value;
      return response;
    },
    set() {
      return response;
    },
  } as unknown as Response;
  return {
    response,
    statusCode: () => statusCode,
    body: () => body,
  };
}

function request(query: string): Request {
  return { query: { q: query } } as unknown as Request;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("place search http contract", () => {
  it("rejects invalid queries with a stable code", async () => {
    const recorder = responseRecorder();
    await handlePlaceSearch(request("ab"), recorder.response);
    expect(recorder.statusCode()).toBe(400);
    expect(recorder.body()).toMatchObject({
      code: "PLACE_SEARCH_INVALID_QUERY",
    });
  });

  it("distinguishes missing server configuration", async () => {
    vi.stubEnv("GOOGLE_MAPS_API_KEY", "");
    const recorder = responseRecorder();
    await handlePlaceSearch(request("missing-config-unique"), recorder.response);
    expect(recorder.statusCode()).toBe(503);
    expect(recorder.body()).toMatchObject({
      code: "PLACE_SEARCH_NOT_CONFIGURED",
    });
  });

  it("distinguishes google quota failure from generic upstream failure", async () => {
    vi.stubEnv("GOOGLE_MAPS_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response("quota", { status: 429 }),
    ));
    const recorder = responseRecorder();
    await handlePlaceSearch(request("quota-case-unique"), recorder.response);
    expect(recorder.statusCode()).toBe(503);
    expect(recorder.body()).toMatchObject({
      code: "PLACE_SEARCH_UPSTREAM_RATE_LIMITED",
    });
  });

  it("keeps the timeout active through response body consumption", async () => {
    vi.useFakeTimers();
    vi.stubEnv("GOOGLE_MAPS_API_KEY", "test-key");
    let markBodyStarted = () => {};
    const bodyStarted = new Promise<void>((resolve) => {
      markBodyStarted = resolve;
    });
    vi.stubGlobal("fetch", vi.fn((_url, init: RequestInit = {}) => Promise.resolve({
      ok: true,
      status: 200,
      text: () => new Promise<string>((_resolve, reject) => {
        markBodyStarted();
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
          once: true,
        });
      }),
    } as Response)));

    const recorder = responseRecorder();
    const pending = handlePlaceSearch(
      request("body-timeout-case-unique"),
      recorder.response,
    );
    await bodyStarted;
    await vi.advanceTimersByTimeAsync(5_000);
    await pending;
    expect(recorder.statusCode()).toBe(504);
    expect(recorder.body()).toMatchObject({
      code: "PLACE_SEARCH_UPSTREAM_TIMEOUT",
    });
  });

  it("reports genuine no-results separately from failures", async () => {
    vi.stubEnv("GOOGLE_MAPS_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ places: [] }), { status: 200 }),
    ));
    const recorder = responseRecorder();
    await handlePlaceSearch(request("no-results-case-unique"), recorder.response);
    expect(recorder.statusCode()).toBe(200);
    expect(recorder.body()).toEqual({
      results: [],
      code: "PLACE_SEARCH_NO_RESULTS",
      message: "No matching places were found.",
    });
  });
});
