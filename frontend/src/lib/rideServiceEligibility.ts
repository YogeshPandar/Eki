import type { ActiveBusEntry } from "./activeBusEntries";

export type DevicePresence = "online" | "offline";
export type RideServiceState =
  | "ride_not_armed"
  | "direction_pending"
  | "pre_departure"
  | "in_service"
  | "completed";

type ServiceEntry = Pick<
  ActiveBusEntry,
  "deviceState" | "status" | "sessionId" | "direction" | "tripState"
>;

export function devicePresence(
  entry: Pick<ActiveBusEntry, "deviceState"> | null | undefined,
): DevicePresence {
  return entry?.deviceState === "online" ? "online" : "offline";
}

export function rideServiceState(
  entry: ServiceEntry | null | undefined,
): RideServiceState {
  if (entry?.tripState === "completed") return "completed";

  const hasSession =
    typeof entry?.sessionId === "string" && entry.sessionId.trim().length > 0;
  if (!hasSession || entry?.status !== "active") return "ride_not_armed";

  if (entry.tripState !== "pre_departure" && entry.tripState !== "in_service") {
    return "ride_not_armed";
  }
  if (entry.direction !== "forward" && entry.direction !== "reverse") {
    return "direction_pending";
  }
  return entry.tripState;
}

export function isPassengerRideVisible(
  entry: ServiceEntry | null | undefined,
): boolean {
  const state = rideServiceState(entry);
  return state === "direction_pending" ||
    state === "pre_departure" ||
    state === "in_service";
}

export function isPassengerServiceEligible(
  entry: ServiceEntry | null | undefined,
): boolean {
  const state = rideServiceState(entry);
  return state === "pre_departure" || state === "in_service";
}

export function countActiveServices(entries: Iterable<ServiceEntry>): number {
  let count = 0;
  for (const entry of entries) {
    if (isPassengerServiceEligible(entry)) count += 1;
  }
  return count;
}
