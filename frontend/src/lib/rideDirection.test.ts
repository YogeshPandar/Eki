import { describe, expect, it } from "vitest";
import {
  directionLabel,
  directionStateLabel,
  directionsMatch,
  persistedDirectionLabel,
  resolvedRideDirection,
  rideDirectionState,
  routeInRideDirection,
} from "./rideDirection";

const route = {
  id: "route_1",
  name: "A-Z",
  color: "#fff",
  polyline: "legacy-forward",
  forwardPolyline: "legal-forward",
  reversePolyline: "legal-reverse",
  polylineQuality: "HIGH_QUALITY" as const,
  waypoints: [{ lat: 1, lng: 1 }, { lat: 2, lng: 2 }],
  stops: [
    { id: "a", name: "Alpha", shortName: "A", lat: 1, lng: 1 },
    { id: "z", name: "Zulu", shortName: "Z", lat: 2, lng: 2 },
  ],
};

describe("pending ride direction", () => {
  it("resolves only explicit forward and reverse values", () => {
    expect(resolvedRideDirection("forward")).toBe("forward");
    expect(resolvedRideDirection("reverse")).toBe("reverse");
    expect(resolvedRideDirection(undefined)).toBeNull();
    expect(resolvedRideDirection(null)).toBeNull();
    expect(resolvedRideDirection("sideways")).toBeNull();
  });

  it("keeps missing and invalid values pending at read boundaries", () => {
    expect(rideDirectionState(undefined)).toBe("pending");
    expect(rideDirectionState(null)).toBe("pending");
    expect(rideDirectionState("sideways")).toBe("pending");
    expect(rideDirectionState("forward")).toBe("forward");
    expect(directionStateLabel("pending", route.stops)).toBe("Direction pending");
  });

  it("never treats two unresolved values as the same operational direction", () => {
    expect(directionsMatch("forward", "forward")).toBe(true);
    expect(directionsMatch("reverse", "reverse")).toBe(true);
    expect(directionsMatch("forward", "reverse")).toBe(false);
    expect(directionsMatch(undefined, undefined)).toBe(false);
    expect(directionsMatch(undefined, "forward")).toBe(false);
  });
});

describe("directional route views", () => {
  it("orders reverse stops and geometry without mutating Firestore route data", () => {
    const reverse = routeInRideDirection(route, "reverse");
    expect(reverse.stops.map((stop) => stop.id)).toEqual(["z", "a"]);
    expect(reverse.waypoints.map((point) => point.lat)).toEqual([2, 1]);
    expect(reverse.rideDirection).toBe("reverse");
    expect(reverse.polyline).toBe("legal-reverse");
    expect(route.stops.map((stop) => stop.id)).toEqual(["a", "z"]);
    expect(directionLabel("reverse", route.stops)).toBe("Z → A");
  });

  it("selects independently routed forward geometry", () => {
    expect(routeInRideDirection(route, "forward").polyline).toBe("legal-forward");
  });

  it("keeps persisted session endpoints stable after the route is edited", () => {
    const editedStops = [
      { id: "new-a", name: "New Alpha", shortName: "NA", lat: 0, lng: 0 },
      ...route.stops,
      { id: "new-z", name: "New Zulu", shortName: "NZ", lat: 3, lng: 3 },
    ];
    expect(persistedDirectionLabel("forward", editedStops, "a", "z")).toBe("A → Z");
    expect(persistedDirectionLabel("reverse", editedStops, "z", "a")).toBe("Z → A");
    expect(persistedDirectionLabel("reverse", editedStops, null, null)).toBe("NZ → NA");
  });
});
