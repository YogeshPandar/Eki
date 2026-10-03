import { describe, expect, it } from "vitest";
import { normalizeObservedRoute, statusOutcome } from "./observabilityPolicy";

describe("frontend observability", () => {
  it("removes query values and dynamic identifiers from route labels", () => {
    expect(normalizeObservedRoute("/api/places?query=home")).toBe("/api/places");
    expect(normalizeObservedRoute("/api/sessions/550e8400-e29b-41d4-a716-446655440000/messages"))
      .toBe("/api/sessions/:id/messages");
    expect(normalizeObservedRoute("/api/devices/device_identifier_12345/diagnostics"))
      .toBe("/api/devices/:id/diagnostics");
  });

  it("maps status codes to bounded outcome labels", () => {
    expect(statusOutcome(204)).toBe("2xx");
    expect(statusOutcome(404)).toBe("4xx");
    expect(statusOutcome(503)).toBe("5xx");
  });
});
