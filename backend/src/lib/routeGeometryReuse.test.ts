import { describe, expect, it } from "vitest";
import {
  reusableDirectionalGeometry,
  sameRouteCoordinates,
} from "./routeGeometryReuse";

const coordinates = [
  { lat: 23.0381, lng: 72.5518 },
  { lat: 23.0401, lng: 72.5542 },
];

const validPolyline = "_p~iF~ps|U_ulLnnqC_mqNvxq`@";

function storedRoute(overrides: Record<string, unknown> = {}) {
  return {
    polylineQuality: "HIGH_QUALITY",
    forwardPolyline: validPolyline,
    reversePolyline: validPolyline,
    distanceMeters: 1_200,
    forwardDistanceMeters: 1_200,
    reverseDistanceMeters: 1_250,
    duration: "180s",
    forwardDuration: "180s",
    reverseDuration: "190.5s",
    ...overrides,
  };
}

describe("route geometry reuse", () => {
  it("requires the exact ordered coordinate sequence", () => {
    expect(sameRouteCoordinates(coordinates, [...coordinates])).toBe(true);
    expect(sameRouteCoordinates(coordinates, [...coordinates].reverse())).toBe(false);
    expect(sameRouteCoordinates(coordinates, [
      coordinates[0],
      { ...coordinates[1], lat: coordinates[1].lat + 0.0000001 },
    ])).toBe(false);
    expect(sameRouteCoordinates(coordinates, [coordinates[0]])).toBe(false);
  });

  it("reuses validated directional geometry for metadata-only edits", () => {
    expect(reusableDirectionalGeometry(
      storedRoute({ name: "old name", color: "#000000" }),
      coordinates,
      [...coordinates],
    )).toEqual({
      polyline: validPolyline,
      forwardPolyline: validPolyline,
      reversePolyline: validPolyline,
      distanceMeters: 1_200,
      forwardDistanceMeters: 1_200,
      reverseDistanceMeters: 1_250,
      duration: "180s",
      forwardDuration: "180s",
      reverseDuration: "190.5s",
      polylineQuality: "HIGH_QUALITY",
    });
  });

  it("recomputes when coordinates or order change", () => {
    expect(reusableDirectionalGeometry(
      storedRoute(),
      coordinates,
      [...coordinates].reverse(),
    )).toBeNull();
    expect(reusableDirectionalGeometry(
      storedRoute(),
      coordinates,
      [coordinates[0], { ...coordinates[1], lng: coordinates[1].lng + 0.000001 }],
    )).toBeNull();
  });

  it.each([
    ["quality", { polylineQuality: "LEGACY" }],
    ["forward polyline", { forwardPolyline: "not-a-polyline" }],
    ["reverse polyline", { reversePolyline: "" }],
    ["distance", { forwardDistanceMeters: Number.NaN }],
    ["negative distance", { reverseDistanceMeters: -1 }],
    ["duration", { reverseDuration: "soon" }],
  ])("recomputes for invalid stored %s", (_label, override) => {
    expect(reusableDirectionalGeometry(
      storedRoute(override),
      coordinates,
      coordinates,
    )).toBeNull();
  });

  it("does not reuse geometry when the previous coordinate sequence is unavailable", () => {
    expect(reusableDirectionalGeometry(
      storedRoute(),
      null,
      coordinates,
    )).toBeNull();
  });
});
