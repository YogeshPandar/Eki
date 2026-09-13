import { decodePolyline } from "./polylineUtils";

export const STORED_ROUTE_POLYLINE_QUALITY = "HIGH_QUALITY" as const;

export interface RouteCoordinate {
  lat: number;
  lng: number;
}

export interface ReusableDirectionalGeometry {
  polyline: string;
  forwardPolyline: string;
  reversePolyline: string;
  distanceMeters: number;
  forwardDistanceMeters: number;
  reverseDistanceMeters: number;
  duration: string;
  forwardDuration: string;
  reverseDuration: string;
  polylineQuality: typeof STORED_ROUTE_POLYLINE_QUALITY;
}

function validCoordinate(value: unknown): value is RouteCoordinate {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.lat === "number" &&
    Number.isFinite(candidate.lat) &&
    candidate.lat >= -90 &&
    candidate.lat <= 90 &&
    typeof candidate.lng === "number" &&
    Number.isFinite(candidate.lng) &&
    candidate.lng >= -180 &&
    candidate.lng <= 180
  );
}

export function sameRouteCoordinates(
  current: readonly RouteCoordinate[] | null,
  next: readonly RouteCoordinate[],
): boolean {
  if (!current || current.length !== next.length || next.length < 2) return false;
  return current.every((point, index) => {
    const candidate = next[index];
    return (
      validCoordinate(point) &&
      validCoordinate(candidate) &&
      point.lat === candidate.lat &&
      point.lng === candidate.lng
    );
  });
}

export function validStoredPolyline(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 500_000) {
    return false;
  }
  try {
    return decodePolyline(value).length >= 2;
  } catch {
    return false;
  }
}

function finiteMetric(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function durationMetric(value: unknown): value is string {
  return typeof value === "string" && /^\d+(?:\.\d+)?s$/.test(value);
}

export function reusableDirectionalGeometry(
  route: Record<string, unknown>,
  currentCoordinates: readonly RouteCoordinate[] | null,
  nextCoordinates: readonly RouteCoordinate[],
): ReusableDirectionalGeometry | null {
  if (
    !sameRouteCoordinates(currentCoordinates, nextCoordinates) ||
    route.polylineQuality !== STORED_ROUTE_POLYLINE_QUALITY ||
    !validStoredPolyline(route.forwardPolyline) ||
    !validStoredPolyline(route.reversePolyline) ||
    !finiteMetric(route.distanceMeters) ||
    !finiteMetric(route.forwardDistanceMeters) ||
    !finiteMetric(route.reverseDistanceMeters) ||
    !durationMetric(route.duration) ||
    !durationMetric(route.forwardDuration) ||
    !durationMetric(route.reverseDuration)
  ) {
    return null;
  }

  return {
    polyline: route.forwardPolyline,
    forwardPolyline: route.forwardPolyline,
    reversePolyline: route.reversePolyline,
    distanceMeters: route.distanceMeters,
    forwardDistanceMeters: route.forwardDistanceMeters,
    reverseDistanceMeters: route.reverseDistanceMeters,
    duration: route.duration,
    forwardDuration: route.forwardDuration,
    reverseDuration: route.reverseDuration,
    polylineQuality: STORED_ROUTE_POLYLINE_QUALITY,
  };
}
