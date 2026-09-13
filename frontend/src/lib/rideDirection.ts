import type { RouteData } from "@/hooks/useRoutes";

export type RideDirection = "forward" | "reverse";
export type RideDirectionState = RideDirection | "pending";

export function resolvedRideDirection(value: unknown): RideDirection | null {
  return value === "forward" || value === "reverse" ? value : null;
}

export function rideDirectionState(value: unknown): RideDirectionState {
  return resolvedRideDirection(value) ?? "pending";
}

export function directionsMatch(left: unknown, right: unknown): boolean {
  const leftDirection = resolvedRideDirection(left);
  const rightDirection = resolvedRideDirection(right);
  return Boolean(leftDirection && rightDirection && leftDirection === rightDirection);
}

export function normalizeRideDirection(value: unknown): RideDirection {
  return value === "reverse" ? "reverse" : "forward";
}

export function directionLabel(
  direction: RideDirection,
  stops: RouteData["stops"],
): string {
  const ordered = direction === "reverse" ? [...stops].reverse() : stops;
  const origin = ordered[0]?.shortName || ordered[0]?.name || "Origin";
  const destination = ordered.at(-1)?.shortName || ordered.at(-1)?.name || "Destination";
  return `${origin} → ${destination}`;
}

export function directionStateLabel(
  direction: RideDirectionState,
  stops: RouteData["stops"],
): string {
  return direction === "pending" ? "Direction pending" : directionLabel(direction, stops);
}

/** Uses immutable session endpoints before falling back to the current route. */
export function persistedDirectionLabel(
  direction: RideDirection,
  stops: RouteData["stops"],
  originStopId: string | null | undefined,
  destinationStopId: string | null | undefined,
): string {
  if (originStopId && destinationStopId) {
    const stopLabel = (stopId: string) => {
      const stop = stops.find((candidate) => candidate.id === stopId);
      return stop?.shortName || stop?.name || stopId;
    };
    return `${stopLabel(originStopId)} → ${stopLabel(destinationStopId)}`;
  }
  return directionLabel(direction, stops);
}

/** Produces a view-only route whose stops and fallback geometry follow travel order. */
export function routeInRideDirection(
  route: RouteData,
  direction: RideDirection,
): RouteData {
  const hasDirectionalGeometry = Boolean(
    route.forwardPolyline && route.reversePolyline,
  );
  if (direction === "forward") {
    return {
      ...route,
      polyline: route.forwardPolyline ?? route.polyline,
      // Force the authenticated geometry repair endpoint for legacy route
      // records rather than pretending one reversible path is directional.
      polylineQuality: hasDirectionalGeometry ? route.polylineQuality : undefined,
    };
  }
  return {
    ...route,
    rideDirection: "reverse",
    polyline: route.reversePolyline,
    polylineQuality: hasDirectionalGeometry ? route.polylineQuality : undefined,
    distanceMeters: route.reverseDistanceMeters ?? route.distanceMeters,
    duration: route.reverseDuration ?? route.duration,
    stops: [...route.stops].reverse(),
    waypoints: [...route.waypoints].reverse(),
  };
}
