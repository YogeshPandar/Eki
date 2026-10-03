import { describe, expect, it } from "vitest";
import { parseFrontendObservabilityBatch } from "./frontendObservability";

describe("frontend observability payload", () => {
  it("accepts bounded privacy-safe signal records", () => {
    const events = [
      { type: "web_vital", name: "LCP", value: 1234.5, rating: "good" },
      { type: "api", route: "/api/v2/ride-sessions/:id", method: "POST", durationMs: 81, outcome: "2xx" },
      { type: "error", kind: "unhandled_rejection" },
    ];
    expect(parseFrontendObservabilityBatch({ events })).toEqual(events);
  });

  it("rejects arbitrary strings and unknown fields", () => {
    expect(parseFrontendObservabilityBatch({ events: [
      { type: "api", route: "/api/places?query=private", method: "GET", durationMs: 2, outcome: "2xx" },
    ] })).toBeNull();
    expect(parseFrontendObservabilityBatch({ events: [
      { type: "error", kind: "window_error", message: "do not ingest" },
    ] })).toBeNull();
  });
});
