import { trace } from "@opentelemetry/api";
import { logger } from "../lib/logger";
import {
  recordFrontendApiMetric,
  recordFrontendErrorMetric,
  recordFrontendWebVitalMetric,
} from "../lib/metrics";

const WEB_VITALS = new Set(["CLS", "FCP", "FID", "INP", "LCP", "TTFB"]);
const RATINGS = new Set(["good", "needs-improvement", "poor"]);
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "_OTHER"]);
const OUTCOMES = new Set(["2xx", "3xx", "4xx", "5xx", "timeout", "network", "other"]);
const ERROR_KINDS = new Set(["window_error", "unhandled_rejection"]);
const SAFE_ROUTE = /^\/[A-Za-z0-9_/:.-]{1,120}$/;
const MAX_EVENTS = 50;

export type FrontendObservabilityEvent =
  | {
      type: "web_vital";
      name: "CLS" | "FCP" | "FID" | "INP" | "LCP" | "TTFB";
      value: number;
      rating: "good" | "needs-improvement" | "poor";
    }
  | {
      type: "api";
      route: string;
      method: string;
      durationMs: number;
      outcome: "2xx" | "3xx" | "4xx" | "5xx" | "timeout" | "network" | "other";
    }
  | {
      type: "error";
      kind: "window_error" | "unhandled_rejection";
    };

export function parseFrontendObservabilityBatch(value: unknown): FrontendObservabilityEvent[] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || !Array.isArray(record.events)) return null;
  if (record.events.length === 0 || record.events.length > MAX_EVENTS) return null;

  const parsed: FrontendObservabilityEvent[] = [];
  for (const item of record.events) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const event = item as Record<string, unknown>;
    if (event.type === "web_vital") {
      if (
        Object.keys(event).length !== 4 ||
        typeof event.name !== "string" || !WEB_VITALS.has(event.name) ||
        typeof event.value !== "number" || !Number.isFinite(event.value) ||
        event.value < 0 || event.value > 600_000 ||
        typeof event.rating !== "string" || !RATINGS.has(event.rating)
      ) return null;
      parsed.push(event as FrontendObservabilityEvent);
      continue;
    }
    if (event.type === "api") {
      if (
        Object.keys(event).length !== 5 ||
        typeof event.route !== "string" || !SAFE_ROUTE.test(event.route) ||
        typeof event.method !== "string" || !METHODS.has(event.method) ||
        typeof event.durationMs !== "number" || !Number.isFinite(event.durationMs) ||
        event.durationMs < 0 || event.durationMs > 120_000 ||
        typeof event.outcome !== "string" || !OUTCOMES.has(event.outcome)
      ) return null;
      parsed.push(event as FrontendObservabilityEvent);
      continue;
    }
    if (event.type === "error") {
      if (
        Object.keys(event).length !== 2 ||
        typeof event.kind !== "string" || !ERROR_KINDS.has(event.kind)
      ) return null;
      parsed.push(event as FrontendObservabilityEvent);
      continue;
    }
    return null;
  }
  return parsed;
}

export function recordFrontendObservabilityBatch(events: FrontendObservabilityEvent[]): void {
  const span = trace.getActiveSpan();
  let runtimeErrors = 0;
  for (const event of events) {
    if (event.type === "web_vital") {
      recordFrontendWebVitalMetric(event.name, event.value, event.rating);
      span?.addEvent("frontend.web_vital", {
        "eki.frontend.web_vital.name": event.name,
        "eki.frontend.web_vital.rating": event.rating,
        "eki.frontend.web_vital.value": event.value,
      });
      continue;
    }
    if (event.type === "api") {
      recordFrontendApiMetric(event.route, event.method, event.durationMs, event.outcome);
      span?.addEvent("frontend.api.request", {
        "http.route": event.route,
        "http.request.method": event.method,
        "eki.frontend.outcome": event.outcome,
        "eki.frontend.duration_ms": event.durationMs,
      });
      continue;
    }
    runtimeErrors += 1;
    recordFrontendErrorMetric(event.kind);
    span?.addEvent("frontend.error", {
      "error.type": event.kind,
      "eki.frontend.source": "browser",
    });
  }
  if (runtimeErrors > 0) {
    logger.warn("Frontend runtime error batch", { count: runtimeErrors });
  }
}
