import { describe, expect, it } from "vitest";
import {
  countActiveServices,
  devicePresence,
  isPassengerRideVisible,
  isPassengerServiceEligible,
  rideServiceState,
} from "./rideServiceEligibility";

describe("device presence", () => {
  it("depends only on the explicit device state", () => {
    expect(devicePresence({ deviceState: "online" })).toBe("online");
    expect(devicePresence({ deviceState: "offline" })).toBe("offline");
    expect(devicePresence(undefined)).toBe("offline");
  });
});

describe("ride service eligibility", () => {
  it("does not turn fresh device presence into a passenger ride or service", () => {
    const deviceOnly = {
      deviceState: "online" as const,
      status: "offline" as const,
      tripState: "pre_departure" as const,
    };
    expect(rideServiceState(deviceOnly)).toBe("ride_not_armed");
    expect(isPassengerRideVisible(deviceOnly)).toBe(false);
    expect(isPassengerServiceEligible(deviceOnly)).toBe(false);
  });

  it("keeps an armed ride visible but not service-eligible until direction resolves", () => {
    const pending = {
      status: "active" as const,
      sessionId: "session_1",
      tripState: "pre_departure" as const,
    };
    expect(rideServiceState(pending)).toBe("direction_pending");
    expect(isPassengerRideVisible(pending)).toBe(true);
    expect(isPassengerServiceEligible(pending)).toBe(false);
  });

  it.each(["pre_departure", "in_service"] as const)(
    "accepts an explicit %s service with session and direction",
    (tripState) => {
      const service = {
        status: "active" as const,
        sessionId: "session_1",
        direction: "forward" as const,
        tripState,
      };
      expect(rideServiceState(service)).toBe(tripState);
      expect(isPassengerRideVisible(service)).toBe(true);
      expect(isPassengerServiceEligible(service)).toBe(true);
    },
  );

  it("does not let an in_service string bypass the service contract", () => {
    expect(isPassengerRideVisible({ tripState: "in_service" })).toBe(false);
    expect(isPassengerServiceEligible({ tripState: "in_service" })).toBe(false);
    expect(isPassengerServiceEligible({
      status: "offline",
      sessionId: "session_1",
      direction: "reverse",
      tripState: "in_service",
    })).toBe(false);
  });

  it("classifies terminal rides separately", () => {
    const completed = {
      status: "active" as const,
      sessionId: "session_1",
      direction: "forward" as const,
      tripState: "completed" as const,
    };
    expect(rideServiceState(completed)).toBe("completed");
    expect(isPassengerRideVisible(completed)).toBe(false);
  });

  it("counts only passenger-eligible services", () => {
    expect(countActiveServices([
      { deviceState: "online", status: "offline", tripState: "pre_departure" },
      { status: "active", sessionId: "pending", tripState: "pre_departure" },
      { status: "active", sessionId: "armed", direction: "forward", tripState: "pre_departure" },
      { status: "active", sessionId: "live", direction: "reverse", tripState: "in_service" },
      { status: "active", sessionId: "done", direction: "forward", tripState: "completed" },
    ])).toBe(2);
  });
});
