import { hasValidBusCoordinates } from "./liveBusFreshness";
import type { LatLng } from "./polyline";
import type { ActiveBusEntry, MatchedLiveLocation } from "./activeBusEntries";

const MIN_DISPLAY_MATCH_CONFIDENCE = 0.45;
export const MATCH_PENDING_HOLD_MS = 2_000;

type LiveBusPositionInput = Pick<
  ActiveBusEntry,
  | "rawLocation"
  | "lat"
  | "lng"
  | "timestamp"
  | "matchedLocation"
  | "routeState"
  | "routeVersion"
>;

export type LiveBusMarkerDecision =
  | { kind: "matched"; position: LatLng }
  | { kind: "match_pending"; position: LatLng }
  | { kind: "raw"; position: LatLng }
  | { kind: "none"; position: null };

function isOnRouteState(value: LiveBusPositionInput["routeState"]): boolean {
  return value === "ON_ROUTE" || value === "ON_NEW_ROUTE";
}

function validDisplayMatch(matched: MatchedLiveLocation): boolean {
  return (
    matched.matchConfidence >= MIN_DISPLAY_MATCH_CONFIDENCE &&
    hasValidBusCoordinates(matched.lat, matched.lng)
  );
}

function currentMatchIsValid(
  input: LiveBusPositionInput,
  matched: MatchedLiveLocation,
): boolean {
  return Boolean(
    isOnRouteState(input.routeState) &&
    validDisplayMatch(matched) &&
    matched.seq === input.rawLocation?.seq &&
    matched.sampledAt === input.timestamp &&
    matched.routeVersion === input.routeVersion,
  );
}

function previousMatchCanBeHeld(
  input: LiveBusPositionInput,
  matched: MatchedLiveLocation,
): boolean {
  const currentTimestamp = input.timestamp;
  const raw = input.rawLocation;
  if (
    !isOnRouteState(input.routeState) ||
    !validDisplayMatch(matched) ||
    !hasValidBusCoordinates(input.lat, input.lng) ||
    !raw ||
    typeof currentTimestamp !== "number" ||
    !Number.isFinite(currentTimestamp) ||
    raw.sampledAt !== currentTimestamp ||
    matched.routeVersion !== input.routeVersion ||
    !Number.isSafeInteger(raw.seq) ||
    matched.seq + 1 !== raw.seq ||
    matched.sampledAt >= currentTimestamp
  ) {
    return false;
  }

  const pendingAgeMs = currentTimestamp - matched.sampledAt;
  return pendingAgeMs <= MATCH_PENDING_HOLD_MS;
}

/* keep one recent confident match while the current on-route match is pending. */
export function liveBusMarkerDecision(
  input: LiveBusPositionInput,
): LiveBusMarkerDecision {
  const matched = input.matchedLocation;
  if (matched && currentMatchIsValid(input, matched)) {
    return {
      kind: "matched",
      position: { lat: matched.lat, lng: matched.lng },
    };
  }
  if (matched && previousMatchCanBeHeld(input, matched)) {
    return {
      kind: "match_pending",
      position: { lat: matched.lat, lng: matched.lng },
    };
  }
  if (!hasValidBusCoordinates(input.lat, input.lng)) {
    return { kind: "none", position: null };
  }
  return {
    kind: "raw",
    position: { lat: input.lat as number, lng: input.lng as number },
  };
}

export function liveBusMarkerPosition(
  input: LiveBusPositionInput,
): LatLng | null {
  return liveBusMarkerDecision(input).position;
}
