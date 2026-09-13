import { describe, expect, it } from "vitest";
import {
  countActiveServices,
  devicePresence,
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
  it("does not turn fresh device presence into passenger service", () => {
    const deviceOnly = {
      deviceState: "online" as const,
      status: "offline" as const,
      tripState: "pre_departure" as const,
    };
    expect(rideServiceState(deviceOnly)).toBe("ride_not_armed");
    expect(isPassengerServiceEligible(deviceOnly)).toBe(false);
  });

  it("keeps an armed ride pending until direction is explicit", () => {
    const pending = {
      status: "active" as const,
      sessionId: "session_1",
      tripState: "pre_departure" as const,
    };
    expect(rideServiceState(pending)).toBe("direction_pending");
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
      expect(isPassengerServiceEligible(service)).toBe(true);
    },
  );

  it("does not let an in_service string bypass the service contract", () => {
    expect(isPassengerServiceEligible({ tripState: "in_service" })).toBe(false);
    expect(isPassengerServiceEligible({
      status: "offline",
      sessionId: "session_1",
      direction: "reverse",
      tripState: "in_service",
    })).toBe(false);
  });

  it("classifies terminal rides separately", () => {
    expect(rideServiceState({
      status: "active",
      sessionId: "session_1",
      direction: "forward",
      tripState: "completed",
    })).toBe("completed");
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
