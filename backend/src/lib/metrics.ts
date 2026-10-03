import { metrics, type Attributes, type ObservableResult } from "@opentelemetry/api";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { BackgroundFailureSnapshot } from "./backgroundFailureTracker";
import type { HealthSnapshot } from "./healthState";
import type { HttpsTelemetryStatus, LatencySummary } from "../services/deviceTelemetryService";

const meter = metrics.getMeter("eki-backend");
const requestCount = meter.createCounter("eki.http.server.requests", {
  description: "Completed HTTP server requests.",
});
const requestDuration = meter.createHistogram("eki.http.server.request.duration", {
  description: "HTTP server request duration.",
  unit: "s",
});
const activeRequests = meter.createUpDownCounter("eki.http.server.active_requests", {
  description: "Currently active HTTP server requests.",
});
const authAttempts = meter.createCounter("eki.auth.attempts", {
  description: "Authentication outcomes without user identifiers.",
});
const backgroundFailureCount = meter.createCounter("eki.background.failures", {
  description: "Background task failures by bounded source name.",
});
const workerRuns = meter.createCounter("eki.worker.runs", {
  description: "Background worker run outcomes.",
});

const frontendApiDuration = meter.createHistogram("eki.frontend.api.request.duration", {
  description: "Observed browser API request duration.",
  unit: "s",
});
const frontendWebVitalDuration = meter.createHistogram("eki.frontend.web_vital.duration", {
  description: "Browser Web Vital duration values.",
  unit: "s",
});
const frontendLayoutShift = meter.createHistogram("eki.frontend.web_vital.cls", {
  description: "Browser Cumulative Layout Shift values.",
  unit: "1",
});
const frontendErrors = meter.createCounter("eki.frontend.errors", {
  description: "Privacy-bounded browser runtime errors.",
});
const hardwareDiagnosticReports = meter.createCounter("eki.hardware.diagnostic.reports", {
  description: "Accepted authenticated device diagnostic reports.",
});
const hardwareEvents = meter.createCounter("eki.hardware.events", {
  description: "Device counter deltas derived from consecutive diagnostic reports.",
});
const hardwareFreeHeap = meter.createHistogram("eki.hardware.free_heap", {
  description: "ESP32 free heap sampled by authenticated diagnostics.",
  unit: "By",
});
const hardwareRssi = meter.createHistogram("eki.hardware.wifi.rssi", {
  description: "ESP32 Wi-Fi RSSI sampled by authenticated diagnostics.",
  unit: "dBm",
});
const hardwareQueueDepth = meter.createHistogram("eki.hardware.telemetry.queue_depth", {
  description: "ESP32 telemetry queue depth sampled by authenticated diagnostics.",
  unit: "{sample}",
});
const hardwareDeliveryAge = meter.createHistogram("eki.hardware.telemetry.last_accepted_age", {
  description: "Age of the last accepted telemetry response observed by firmware.",
  unit: "ms",
});
const hardwareRetryRemaining = meter.createHistogram("eki.hardware.telemetry.retry_remaining", {
  description: "Remaining firmware telemetry retry delay.",
  unit: "ms",
});

let workerLeader = 0;
meter.createObservableGauge("eki.worker.leader", {
  description: "One when this instance currently owns the worker lease.",
}).addCallback(result => result.observe(workerLeader));
meter.createObservableGauge("eki.process.heap.used", {
  description: "JavaScript heap currently used by this backend process.",
  unit: "By",
}).addCallback(result => result.observe(process.memoryUsage().heapUsed));

function routeLabel(req: Request): string {
  const routePath = (req.route as { path?: unknown } | undefined)?.path;
  if (typeof routePath === "string") return `${req.baseUrl || ""}${routePath}` || "/";
  return req.path
    .replace(/\/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "/:id")
    .replace(/\/[A-Za-z0-9_-]{16,}(?=\/|$)/g, "/:id")
    .replace(/\/\d+(?=\/|$)/g, "/:id");
}

export function createHttpMetricsMiddleware(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.path === "/health") {
      next();
      return;
    }
    const started = performance.now();
    const activeAttributes: Attributes = { "http.request.method": req.method };
    activeRequests.add(1, activeAttributes);
    res.once("finish", () => {
      activeRequests.add(-1, activeAttributes);
      const attributes: Attributes = {
        "http.request.method": req.method,
        "http.route": routeLabel(req),
        "http.response.status_code": res.statusCode,
        "http.response.status_class": `${Math.floor(res.statusCode / 100)}xx`,
      };
      requestCount.add(1, attributes);
      requestDuration.record((performance.now() - started) / 1_000, attributes);
    });
    next();
  };
}

export function recordAuthAttempt(outcome: "success" | "missing" | "denied" | "capacity" | "error"): void {
  authAttempts.add(1, { outcome });
}

export function recordBackgroundFailureMetric(source: string): void {
  backgroundFailureCount.add(1, { source });
}

export function setWorkerLeadership(isLeader: boolean): void {
  workerLeader = isLeader ? 1 : 0;
}

export function recordWorkerRun(worker: string, outcome: "success" | "failure"): void {
  workerRuns.add(1, { worker, outcome });
}

function observeLatency(
  result: ObservableResult,
  stage: string,
  summary: LatencySummary,
): void {
  const statistics = {
    average: summary.average,
    p50: summary.p50,
    p95: summary.p95,
    p99: summary.p99,
  };
  for (const [statistic, value] of Object.entries(statistics)) {
    if (value !== null) result.observe(value, { stage, statistic });
  }
}

let operationalMetricsRegistered = false;

export function registerOperationalMetrics(readers: {
  health: () => HealthSnapshot;
  telemetry: () => HttpsTelemetryStatus;
  background: () => BackgroundFailureSnapshot;
}): void {
  if (operationalMetricsRegistered) return;
  operationalMetricsRegistered = true;

  meter.createObservableGauge("eki.dependency.ready", {
    description: "Dependency readiness by backend store.",
  }).addCallback(result => {
    const health = readers.health();
    result.observe(health.firestore === "connected" ? 1 : 0, { dependency: "firestore" });
    result.observe(health.rtdb === "connected" ? 1 : 0, { dependency: "rtdb" });
  });

  meter.createObservableCounter("eki.device.telemetry.accepted", {
    description: "Cumulative accepted device telemetry samples.",
  }).addCallback(result => result.observe(readers.telemetry().accepted));
  meter.createObservableCounter("eki.device.telemetry.rejected", {
    description: "Cumulative rejected device telemetry samples.",
  }).addCallback(result => result.observe(readers.telemetry().rejected));
  meter.createObservableGauge("eki.device.credential_cache.hit_ratio", {
    description: "Device credential cache hit ratio.",
  }).addCallback(result => {
    const value = readers.telemetry().credentialCacheHitRate;
    if (value !== null) result.observe(value);
  });
  meter.createObservableGauge("eki.device.telemetry.latency", {
    description: "Device telemetry latency summaries by processing stage.",
    unit: "ms",
  }).addCallback(result => {
    const telemetry = readers.telemetry();
    observeLatency(result, "processing", telemetry.processingLatencyMs);
    observeLatency(result, "device_queue", telemetry.deviceQueueLatencyMs);
    observeLatency(result, "network", telemetry.networkLatencyMs);
    observeLatency(result, "device_to_server", telemetry.deviceToServerLatencyMs);
    observeLatency(result, "rtdb_write", telemetry.rtdbWriteLatencyMs);
  });

  meter.createObservableCounter("eki.background.failures.total", {
    description: "Cumulative tracked background task failures.",
  }).addCallback(result => result.observe(readers.background().totalFailures));
  meter.createObservableGauge("eki.background.sustained_sources", {
    description: "Number of background sources currently failing persistently.",
  }).addCallback(result => result.observe(readers.background().sustainedSources.length));
}


type HardwareDiagnosticMetrics = {
  freeHeapBytes: number;
  rssiDbm: number;
  queueDepth: number;
  acceptedFixes: number;
  rejectedFixes: number;
  queueOverflowDrops: number;
  queueStaleDrops: number;
  scheduledHttpsRetries: number;
  resetTotal: number;
  acceptedSeen: boolean;
  acceptedAgeMs: number;
  retryRemainingMs: number;
  fault: "none" | "credential-rejected";
  flashEncryption: boolean;
  secureBoot: boolean;
};

const hardwareCounterState = new Map<string, Pick<HardwareDiagnosticMetrics,
  "acceptedFixes" | "rejectedFixes" | "queueOverflowDrops" | "queueStaleDrops" |
  "scheduledHttpsRetries" | "resetTotal">>();
const MAX_HARDWARE_COUNTER_DEVICES = 5_000;

export function diagnosticCounterDelta(previous: number | undefined, current: number): number {
  if (previous === undefined) return 0;
  return current >= previous ? current - previous : current;
}

export function recordDeviceDiagnosticMetrics(deviceId: string, value: HardwareDiagnosticMetrics): void {
  hardwareDiagnosticReports.add(1, {
    fault: value.fault,
    "eki.hardware.flash_encryption": value.flashEncryption,
    "eki.hardware.secure_boot": value.secureBoot,
  });
  hardwareFreeHeap.record(value.freeHeapBytes);
  hardwareRssi.record(value.rssiDbm);
  hardwareQueueDepth.record(value.queueDepth);
  if (value.acceptedSeen) hardwareDeliveryAge.record(value.acceptedAgeMs);
  hardwareRetryRemaining.record(value.retryRemainingMs);

  const previous = hardwareCounterState.get(deviceId);
  const counters = {
    acceptedFixes: value.acceptedFixes,
    rejectedFixes: value.rejectedFixes,
    queueOverflowDrops: value.queueOverflowDrops,
    queueStaleDrops: value.queueStaleDrops,
    scheduledHttpsRetries: value.scheduledHttpsRetries,
    resetTotal: value.resetTotal,
  };
  if (previous) {
    const names = Object.keys(counters) as Array<keyof typeof counters>;
    for (const name of names) {
      const delta = diagnosticCounterDelta(previous[name], counters[name]);
      if (delta > 0) hardwareEvents.add(delta, { event: name });
    }
  }
  if (!previous && hardwareCounterState.size >= MAX_HARDWARE_COUNTER_DEVICES) {
    const oldest = hardwareCounterState.keys().next().value as string | undefined;
    if (oldest) hardwareCounterState.delete(oldest);
  }
  hardwareCounterState.delete(deviceId);
  hardwareCounterState.set(deviceId, counters);
}

export function recordFrontendWebVitalMetric(
  name: "CLS" | "FCP" | "FID" | "INP" | "LCP" | "TTFB",
  value: number,
  rating: "good" | "needs-improvement" | "poor",
): void {
  if (name === "CLS") frontendLayoutShift.record(value, { rating });
  else frontendWebVitalDuration.record(value / 1_000, { name, rating });
}

export function recordFrontendApiMetric(
  route: string,
  method: string,
  durationMs: number,
  outcome: string,
): void {
  frontendApiDuration.record(durationMs / 1_000, {
    "http.route": route,
    "http.request.method": method,
    outcome,
  });
}

export function recordFrontendErrorMetric(kind: "window_error" | "unhandled_rejection"): void {
  frontendErrors.add(1, { "error.type": kind });
}
