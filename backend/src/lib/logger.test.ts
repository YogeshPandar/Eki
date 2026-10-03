import { describe, expect, it } from "vitest";
import { sanitizeLogValue } from "./logger";

describe("structured log redaction", () => {
  it("removes credential, location and bearer values before export", () => {
    expect(sanitizeLogValue({
      authorization: "Bearer secret-token",
      nested: { latitude: 23.1, message: "Bearer abc.def.ghi" },
      value: "safe",
    })).toEqual({
      authorization: "[REDACTED]",
      nested: { latitude: "[REDACTED]", message: "Bearer [REDACTED]" },
      value: "safe",
    });
  });
});
