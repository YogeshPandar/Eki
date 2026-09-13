import { afterEach, describe, expect, it, vi } from "vitest";
import { searchGooglePlaces } from "./placeSearch";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("searchGooglePlaces", () => {
  it("normalizes valid google place results", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      places: [
        {
          displayName: { text: "  Ahmedabad University  " },
          formattedAddress: "Navrangpura, Ahmedabad",
          location: { latitude: 23.0396, longitude: 72.5525 },
        },
        {
          displayName: { text: "bad coordinates" },
          location: { latitude: 91, longitude: 72 },
        },
      ],
    }), { status: 200 }));

    await expect(searchGooglePlaces("Ahmedabad University", "test-key", {
      fetchImpl,
    })).resolves.toEqual({
      ok: true,
      results: [{
        name: "Ahmedabad University",
        address: "Navrangpura, Ahmedabad",
        lat: 23.0396,
        lng: 72.5525,
      }],
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://places.googleapis.com/v1/places:searchText",
      expect.objectContaining({
        method: "POST",
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("returns an empty success for genuine no results", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ places: [] }), { status: 200 }),
    );
    await expect(searchGooglePlaces("zzzz-no-place", "test-key", {
      fetchImpl,
    })).resolves.toEqual({ ok: true, results: [] });
  });

  it("distinguishes upstream rate limits and other failures", async () => {
    const rateLimited = vi.fn().mockResolvedValue(
      new Response("quota exceeded", { status: 429 }),
    );
    const unavailable = vi.fn().mockResolvedValue(
      new Response("upstream down", { status: 503 }),
    );

    await expect(searchGooglePlaces("Ahmedabad", "test-key", {
      fetchImpl: rateLimited,
    })).resolves.toEqual({
      ok: false,
      reason: "rate_limit",
      upstreamStatus: 429,
    });
    await expect(searchGooglePlaces("Ahmedabad", "test-key", {
      fetchImpl: unavailable,
    })).resolves.toEqual({
      ok: false,
      reason: "upstream",
      upstreamStatus: 503,
    });
  });

  it("distinguishes malformed success payloads from network failures", async () => {
    const malformed = vi.fn().mockResolvedValue(
      new Response("not-json", { status: 200 }),
    );
    const network = vi.fn().mockRejectedValue(new TypeError("network down"));

    await expect(searchGooglePlaces("Ahmedabad", "test-key", {
      fetchImpl: malformed,
    })).resolves.toEqual({ ok: false, reason: "invalid_response" });
    await expect(searchGooglePlaces("Ahmedabad", "test-key", {
      fetchImpl: network,
    })).resolves.toEqual({ ok: false, reason: "network" });
  });

  it("keeps the timeout active while the response body is being read", async () => {
    vi.useFakeTimers();
    let markBodyStarted = () => {};
    const bodyStarted = new Promise<void>((resolve) => {
      markBodyStarted = resolve;
    });
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) =>
      Promise.resolve({
        ok: true,
        status: 200,
        text: () => new Promise<string>((_resolve, reject) => {
          markBodyStarted();
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        }),
      } as Response),
    );

    const request = searchGooglePlaces("Ahmedabad", "test-key", {
      fetchImpl: fetchImpl as typeof fetch,
      timeoutMs: 5_000,
    });
    await bodyStarted;
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(request).resolves.toEqual({ ok: false, reason: "timeout" });
  });

  it("times out when no response headers arrive", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
          once: true,
        });
      }),
    );

    const request = searchGooglePlaces("Ahmedabad", "test-key", {
      fetchImpl: fetchImpl as typeof fetch,
      timeoutMs: 5_000,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(request).resolves.toEqual({ ok: false, reason: "timeout" });
  });
});
