import { describe, expect, it } from "vitest";
import { diagnosticCounterDelta } from "./metrics";

describe("diagnosticCounterDelta", () => {
  it("does not replay cumulative counters on the first report", () => {
    expect(diagnosticCounterDelta(undefined, 20)).toBe(0);
  });

  it("reports increments and treats a reset as a fresh counter", () => {
    expect(diagnosticCounterDelta(20, 27)).toBe(7);
    expect(diagnosticCounterDelta(27, 3)).toBe(3);
  });
});
