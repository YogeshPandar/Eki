import { describe, expect, it } from "vitest";
import { isTelemetryEnabled, redactHttpSpanUrl } from "./instrumentation";

describe("OpenTelemetry configuration", () => {
  it("stays disabled when no OTLP endpoint is configured", () => {
    expect(isTelemetryEnabled({})).toBe(false);
  });

  it("accepts shared or signal-specific OTLP endpoints", () => {
    expect(isTelemetryEnabled({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318" }))
      .toBe(true);
    expect(isTelemetryEnabled({
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://collector:4318/v1/traces",
    })).toBe(true);
    expect(isTelemetryEnabled({
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://collector:4318/v1/metrics",
    })).toBe(true);
    expect(isTelemetryEnabled({
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://collector:4318/v1/logs",
    })).toBe(true);
  });

  it("honors the SDK kill switch", () => {
    expect(isTelemetryEnabled({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
      OTEL_SDK_DISABLED: " TRUE ",
    })).toBe(false);
  });

  it("redacts HTTP URL attributes before exporting spans", () => {
    const attributes: Record<string, string> = {};
    redactHttpSpanUrl((key, value) => {
      attributes[key] = value;
    });

    expect(attributes).toEqual({
      "http.target": "/[redacted]",
      "http.url": "[redacted]",
      "url.full": "[redacted]",
      "url.path": "/[redacted]",
      "url.query": "",
    });
  });
});
