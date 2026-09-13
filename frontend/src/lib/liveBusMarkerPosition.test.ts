import { describe, expect, it } from "vitest";
import {
  MATCH_PENDING_HOLD_MS,
  liveBusMarkerDecision,
  liveBusMarkerPosition,
} from "./liveBusMarkerPosition";

function currentMatchedInput() {
  return {
    lat: 23.012441,
    lng: 72.458011,
    timestamp: 2_000,
    routeState: "ON_ROUTE" as const,
    routeVersion: 4,
    rawLocation: {
      lat: 23.012441,
      lng: 72.458011,
      speed: 18,
      heading: 94,
      gpsHdop: 4,
      motionState: "moving" as const,
      seq: 11,
      sampledAt: 2_000,
    },
    matchedLocation: {
      lat: 23.0124,
      lng: 72.458,
      segmentIndex: 8,
      segmentFraction: 0.5,
      alongRouteDistanceM: 800,
      distanceToRouteM: 5,
      headingDifference: 2,
      matchConfidence: 0.92,
      seq: 11,
      sampledAt: 2_000,
      routeVersion: 4,
    },
  };
}

describe("live bus marker position", () => {
  it("uses raw RTDB coordinates when no accepted match exists", () => {
    expect(liveBusMarkerDecision({ lat: 23.012441, lng: 72.458011 })).toEqual({
      kind: "raw",
      position: { lat: 23.012441, lng: 72.458011 },
    });
  });

  it("uses each new telemetry fix when there is no pending route match", () => {
    const first = liveBusMarkerPosition({ lat: 23.012441, lng: 72.458011 });
    const next = liveBusMarkerPosition({ lat: 23.012991, lng: 72.458731 });

    expect(next).toEqual({ lat: 23.012991, lng: 72.458731 });
    expect(next).not.toEqual(first);
  });

  it.each([
    [undefined, 72.5],
    [23, undefined],
    [91, 72.5],
    [23, 181],
  ])("rejects an invalid position (%p, %p)", (lat, lng) => {
    expect(liveBusMarkerDecision({ lat, lng })).toEqual({
      kind: "none",
      position: null,
    });
  });

  it("uses a confident current-version matched position", () => {
    expect(liveBusMarkerDecision(currentMatchedInput())).toEqual({
      kind: "matched",
      position: { lat: 23.0124, lng: 72.458 },
    });
  });

  it("holds the immediately previous confident match while the next match is pending", () => {
    const input = currentMatchedInput();
    input.matchedLocation = {
      ...input.matchedLocation,
      lat: 23.0122,
      lng: 72.4578,
      seq: 10,
      sampledAt: 1_000,
    };

    expect(liveBusMarkerDecision(input)).toEqual({
      kind: "match_pending",
      position: { lat: 23.0122, lng: 72.4578 },
    });
  });

  it("falls back to raw after the pending-match hold expires", () => {
    const input = currentMatchedInput();
    input.timestamp = 1_000 + MATCH_PENDING_HOLD_MS + 1;
    input.rawLocation = {
      ...input.rawLocation,
      seq: 11,
      sampledAt: input.timestamp,
    };
    input.matchedLocation = {
      ...input.matchedLocation,
      seq: 10,
      sampledAt: 1_000,
    };

    expect(liveBusMarkerDecision(input)).toEqual({
      kind: "raw",
      position: { lat: input.lat, lng: input.lng },
    });
  });

  it("does not hold a match that skipped more than one telemetry sequence", () => {
    const input = currentMatchedInput();
    input.matchedLocation = {
      ...input.matchedLocation,
      seq: 9,
      sampledAt: 1_000,
    };

    expect(liveBusMarkerDecision(input).kind).toBe("raw");
  });

  it("does not treat a same-timestamp stale sequence as pending", () => {
    const input = currentMatchedInput();
    input.matchedLocation = {
      ...input.matchedLocation,
      seq: 10,
      sampledAt: input.timestamp,
    };

    expect(liveBusMarkerDecision(input).kind).toBe("raw");
  });

  it("falls back to raw when the previous match is low confidence", () => {
    const input = currentMatchedInput();
    input.matchedLocation = {
      ...input.matchedLocation,
      matchConfidence: 0.2,
      seq: 10,
      sampledAt: 1_000,
    };

    expect(liveBusMarkerDecision(input).kind).toBe("raw");
  });

  it.each(["POSSIBLE_OFF_ROUTE", "OFF_ROUTE", "REROUTING"] as const)(
    "uses raw telemetry while route state is %s",
    (routeState) => {
      const input = currentMatchedInput();
      expect(liveBusMarkerDecision({
        ...input,
        routeState,
        matchedLocation: {
          ...input.matchedLocation,
          seq: 10,
          sampledAt: 1_000,
        },
      })).toEqual({
        kind: "raw",
        position: { lat: input.lat, lng: input.lng },
      });
    },
  );

  it("rejects a stale matched route version", () => {
    const input = currentMatchedInput();
    input.matchedLocation = {
      ...input.matchedLocation,
      seq: 10,
      sampledAt: 1_000,
      routeVersion: 3,
    };
    expect(liveBusMarkerDecision(input).kind).toBe("raw");
  });

  it("does not move backward to a late result from an older sample", () => {
    const input = currentMatchedInput();
    input.timestamp = 3_000;
    input.rawLocation = {
      ...input.rawLocation,
      seq: 12,
      sampledAt: 3_000,
    };
    input.matchedLocation = {
      ...input.matchedLocation,
      lat: 23.011,
      lng: 72.457,
      seq: 10,
      sampledAt: 1_000,
    };

    expect(liveBusMarkerDecision(input)).toEqual({
      kind: "raw",
      position: { lat: input.lat, lng: input.lng },
    });
  });

  it("uses raw telemetry after a sequence reset instead of holding an old match", () => {
    const input = currentMatchedInput();
    input.timestamp = 5_000;
    input.rawLocation = {
      ...input.rawLocation,
      seq: 1,
      sampledAt: 5_000,
    };
    input.matchedLocation = {
      ...input.matchedLocation,
      seq: 500,
      sampledAt: 4_000,
    };

    expect(liveBusMarkerDecision(input).kind).toBe("raw");
  });
});
