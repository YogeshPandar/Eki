"use client";

import { normalizeObservedRoute, type ObservabilityOutcome } from "./observabilityPolicy";

const MAX_EVENTS = 25;
const FLUSH_INTERVAL_MS = 10_000;
const VALID_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

type WebVitalName = "CLS" | "FCP" | "FID" | "INP" | "LCP" | "TTFB";
type Rating = "good" | "needs-improvement" | "poor";
type Outcome = ObservabilityOutcome;
type Event =
  | { type: "web_vital"; name: WebVitalName; value: number; rating: Rating }
  | { type: "api"; route: string; method: string; durationMs: number; outcome: Outcome }
  | { type: "error"; kind: "window_error" | "unhandled_rejection" };

let queue: Event[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;
let sampled: boolean | null = null;

function sampleEnabled(): boolean {
  if (process.env.NODE_ENV === "test") return false;
  if (sampled !== null) return sampled;
  const configured = Number(process.env.NEXT_PUBLIC_OBSERVABILITY_SAMPLE_RATE ?? "0.1");
  const rate = Number.isFinite(configured) ? Math.min(1, Math.max(0, configured)) : 0.1;
  sampled = Math.random() < rate;
  return sampled;
}

function backendUrl(): string | null {
  const configured = process.env.NEXT_PUBLIC_BACKEND_URL;
  if (!configured) return null;
  try {
    const url = new URL(configured);
    if ((url.protocol !== "http:" && url.protocol !== "https:") ||
        url.username || url.password || url.search || url.hash) return null;
    return url.href.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function observedMethod(value: string | undefined): string {
  const method = (value || "GET").toUpperCase();
  return VALID_METHODS.has(method) ? method : "_OTHER";
}

function scheduleFlush(): void {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushFrontendObservability();
  }, FLUSH_INTERVAL_MS);
}

function enqueue(event: Event): void {
  if (!sampleEnabled()) return;
  if (queue.length >= MAX_EVENTS) queue.shift();
  queue.push(event);
  if (queue.length >= 10) void flushFrontendObservability();
  else scheduleFlush();
}

export async function flushFrontendObservability(): Promise<void> {
  if (flushing || queue.length === 0) return;
  const url = backendUrl();
  if (!url) {
    queue = [];
    return;
  }
  flushing = true;
  const batch = queue.splice(0, MAX_EVENTS);
  const requeue = () => {
    queue = [...batch, ...queue].slice(-MAX_EVENTS);
  };
  try {
    const { auth } = await import("./firebaseAuth");
    const user = auth.currentUser;
    if (!user) return;
    const token = await user.getIdToken();
    const response = await fetch(`${url}/api/observability/frontend`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ events: batch }),
      keepalive: true,
    });
    if (response.status === 429 || response.status >= 500) requeue();
  } catch {
    requeue();
  } finally {
    flushing = false;
    if (queue.length > 0) scheduleFlush();
  }
}

export function recordWebVital(name: string, value: number, rating: string): void {
  if (!["CLS", "FCP", "FID", "INP", "LCP", "TTFB"].includes(name)) return;
  if (!["good", "needs-improvement", "poor"].includes(rating)) return;
  if (!Number.isFinite(value) || value < 0) return;
  enqueue({ type: "web_vital", name: name as WebVitalName, value, rating: rating as Rating });
}

export function recordApiObservation(
  path: string,
  method: string | undefined,
  durationMs: number,
  outcome: Outcome,
): void {
  if (!Number.isFinite(durationMs) || durationMs < 0) return;
  enqueue({
    type: "api",
    route: normalizeObservedRoute(path),
    method: observedMethod(method),
    durationMs: Math.min(durationMs, 120_000),
    outcome,
  });
}

export function recordFrontendError(kind: "window_error" | "unhandled_rejection"): void {
  enqueue({ type: "error", kind });
}
