export type ObservabilityOutcome = "2xx" | "3xx" | "4xx" | "5xx" | "timeout" | "network" | "other";

export function normalizeObservedRoute(path: string): string {
  const pathname = path.split("?", 1)[0] || "/";
  return pathname
    .replace(/\/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "/:id")
    .replace(/\/[A-Za-z0-9_-]{16,}(?=\/|$)/g, "/:id")
    .replace(/\/\d+(?=\/|$)/g, "/:id")
    .slice(0, 120);
}

export function statusOutcome(status: number): ObservabilityOutcome {
  if (status >= 200 && status < 300) return "2xx";
  if (status >= 300 && status < 400) return "3xx";
  if (status >= 400 && status < 500) return "4xx";
  if (status >= 500 && status < 600) return "5xx";
  return "other";
}
