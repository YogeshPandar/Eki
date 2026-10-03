# Observability

Eki uses OpenTelemetry for backend traces, metrics and logs, Grafana LGTM for the local observability backend, a privacy-bounded browser RUM channel, and authenticated firmware diagnostics that are translated into OpenTelemetry metrics by the backend.

## Local stack

Run:

```bash
docker compose -f observability/docker-compose.yml up -d
```

Grafana is available on `http://127.0.0.1:3000` with local-only `admin` / `admin`. OTLP/gRPC is on `4317` and OTLP/HTTP is on `4318`. The Compose image is pinned to `grafana/otel-lgtm:0.34.0`; it includes the OpenTelemetry Collector, Prometheus, Tempo, Loki and Grafana and is intended for development/test use.

For a locally started backend:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 \
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf \
OTEL_SEMCONV_STABILITY_OPT_IN=http \
npm run dev --workspace=backend
```

The backend SDK remains disabled when no shared or signal-specific OTLP endpoint is configured.

## Signal coverage

Backend traces are produced by the Node auto-instrumentations. Request URLs are redacted before export; route templates, methods, status classes and bounded operational attributes are retained. Background failures create explicit error spans.

Backend metrics cover request rate/latency, auth outcomes, dependency readiness, worker state, heap, telemetry ingestion and background failures. Application logs are structured through Pino and the OpenTelemetry Logs SDK; authorization values, credentials, location fields and other sensitive keys are redacted.

The browser does not embed the OpenTelemetry browser SDK. OpenTelemetry JavaScript documents browser client instrumentation as experimental, so the static Firebase frontend instead sends a sampled, authenticated batch containing only closed enums, normalized API route templates, durations and Web Vitals. Query values, URLs, user IDs, error messages and stacks are not accepted by the backend schema. The backend converts those events into metrics, trace events and bounded error logs.

ESP32 firmware does not run an OpenTelemetry SDK. It extends the existing authenticated diagnostics payload with delivery ages, publish/retry counters and retry state. The backend derives aggregate deltas without exporting `deviceId` as a metric label, avoiding fleet-sized label cardinality.

## Validation

CI/unit coverage must verify:

- OTLP enable/disable behavior for shared and per-signal endpoints;
- URL/log redaction and bounded browser event schemas;
- route normalization removes query text and dynamic identifiers;
- hardware cumulative-counter reset handling;
- unsigned ESP32 `millis()` rollover for diagnostic ages/retry remaining;
- the native firmware tests and both web workspace test suites;
- the Grafana LGTM Compose file parses before merge.

Live acceptance should additionally confirm one backend request produces a Tempo trace, a matching Loki log carries trace correlation when emitted inside that request, Prometheus receives the request metric, a signed-in browser produces Web Vitals/API metrics, and an authenticated device diagnostic produces hardware metrics.

## Source specifications

Implementation choices follow the OpenTelemetry JavaScript documentation and OTLP exporter configuration, OpenTelemetry HTTP semantic conventions, the Collector pipeline model, Next.js `useReportWebVitals`, and Grafana's official Docker OpenTelemetry LGTM dashboard provisioning guidance. Hardware remains on the repository-pinned `espressif32@7.0.1` PlatformIO platform and uses only existing Arduino/ESP-IDF runtime primitives for the added diagnostics.
