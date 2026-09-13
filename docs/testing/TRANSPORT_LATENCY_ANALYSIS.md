# Transport latency capture analysis

This offline tool supports the measurement work in upstream
[#159](https://github.com/notnamansinha/Eki/issues/159) and
[#168](https://github.com/notnamansinha/Eki/issues/168). It does not claim either
issue's real-drive acceptance criteria are complete. No packages, credentials,
network requests or backend changes are required.

## Capture and compare

The producer is the opt-in firmware instrumentation in
[fork PR #1](https://github.com/YogeshPandar/Eki/pull/1). Append
`-D EKI_TRANSPORT_METRICS=1` to the selected development environment's existing
build flags, preserving every other flag. For a valid comparison, instrument the
baseline firmware at the same timing boundaries without its session-reuse fix.
A baseline without transport records cannot be analyzed by this tool.

Save completed UTF-8 serial captures as ordinary local files, then run:

```sh
node scripts/analyze-transport-latency.mjs before.log after.log > comparison.json
node --test scripts/analyze-transport-latency.test.mjs
```

Inputs are analyzed independently and identified by argument position (`input: 1`,
`input: 2`, and so on), not by private paths. Records are never pooled. JSON is
emitted only after every input succeeds. Exit code 2 means invalid usage,
unreadable input, malformed records, exceeded limits or no matching data. Shell
redirection can still create an empty output file on failure, so check the exit
status before publishing a result.

## Accepted records

Current firmware records have this exact shape:

```text
[Transport] seq=<uint32> status=<http-or-negative-transport-code> socket_open_before=<0|1> headers_ms=<uint32> total_ms=<uint32> reusable=<0|1> connect_attempts=<uint32> connect_ms=<uint32>
```

The analyzer also accepts the earlier shape ending after `reusable=<0|1>` so
identically instrumented baseline captures remain usable. Missing connection
fields are reported as unknown; they are never converted into zero attempts or a
zero-millisecond connection.

Monitor prefixes, CRLF, fragmented reads and an unterminated final record are
supported. Unrelated lines are counted but not retained. A line containing the
marker must match one complete record. Trailing fields, one-sided connection
fields, invalid flags and inconsistent ranges fail instead of silently biasing
the capture. `total_ms` must be at least `headers_ms`. When connection fields are
present, zero attempts require zero connection time and `connect_ms` cannot
exceed `headers_ms`. Repeated sequence IDs remain separate attempts because
retries are relevant measurements, not accidental duplicate samples.

## Report meaning

The output has `schemaVersion: 2`. Every capture includes its sample count,
ignored-line count, HTTP status counts, connection-observation coverage and two
independent group families.

### Socket-state groups

| Group | Meaning |
| --- | --- |
| `accepted_socket_closed` | HTTP 200/202; transport reported closed before POST |
| `accepted_socket_open_candidate` | HTTP 200/202; transport reported open before POST |
| `nonaccepted_socket_closed` | Other HTTP status or negative transport error; transport reported closed |
| `nonaccepted_socket_open_candidate` | Other HTTP status or negative transport error; transport reported open |

These groups preserve compatibility with earlier records. An open socket is only
a reuse candidate because the peer may have closed it between checks.

### Observed-connect groups

Records containing both connection fields are additionally separated into:

| Group | Meaning |
| --- | --- |
| `accepted_no_connect_attempt` | HTTP 200/202; no call to the instrumented connect overload |
| `accepted_connect_attempted` | HTTP 200/202; one or more instrumented connect calls |
| `nonaccepted_no_connect_attempt` | Other status/error; no instrumented connect call |
| `nonaccepted_connect_attempted` | Other status/error; one or more instrumented connect calls |

`connectionObservations.observedRecords` counts records with connection fields;
`unknownRecords` counts legacy records. `requestsWithAttempt` is the number of
requests that called the instrumented overload, while `totalAttempts` is the sum
of their attempt counters. `connectMs` describes the recorded duration for
requests with at least one attempt. In the current firmware redirects are
disabled and a request path has at most one connect call; the analyzer still
preserves the counter rather than assuming that future producers cannot retry.

Every non-empty group reports count, retained-response count, and nearest-rank
minimum, p50, p95, p99 and maximum for:

- `headersMs`: POST start through response headers;
- `cleanupMs`: `total_ms - headers_ms`;
- `totalMs`: POST start through response cleanup;
- `connectMs` in observed-connect groups: the producer's recorded connect-call
  duration for requests with an attempt.

Observed-connect groups also report how many records had an open-socket candidate
and the sum of their connection attempts. Empty distributions are `null`, not
false zero-latency results. Percentiles use the observed value at rank
`ceil(p * count / 100)`, with ranks starting at one. Small sample counts are not
evidence of a stable tail percentile.

`headers_ms` includes any DNS/TCP/TLS setup, upload, backend work and HTTP header
processing. `connect_ms` includes DNS, TCP and TLS in the reviewed firmware; it
does not isolate certificate verification. `total_ms` additionally includes
response cleanup. `reusable=1` means cleanup completed and the transport still
reported connected; it does not prove the next request reused the socket. A
closed socket does not prove a cold certificate cache. The tool therefore does
not label observations as verified cold/resumed TLS handshakes or calculate a
causal speedup from mixed network conditions.

Use the same board, backend, instrumentation and comparable radio conditions for
before/after captures. Separate startup, continuous moving telemetry, stopped
heartbeats, diagnostics, manifest checks, reconnects and OTA checks. Record
firmware hashes, sample counts and conditions alongside the report. Confirm
actual TLS handshakes with staging proxy connection logs or a controlled packet
capture, and correlate backend processing, RTDB and browser measurements
separately. Do not interpret intentional stopped-heartbeat gaps as dropped
moving telemetry.

## Bounds and privacy

Each input is limited to 100,000 transport records, 4,096 UTF-16 code units per
line and 64 MiB of decoded text measured as UTF-8 bytes. The file reader uses
64 KiB chunks, bounds partial lines and closes its stream on completion or
failure. Limits reject an input rather than silently truncating it. Exact
percentiles retain bounded numeric records and sort per-group arrays; the tool
does not claim an unbounded constant-memory quantile algorithm.

Use completed ordinary files, not an active serial device or a never-ending
pipe. JSON contains numeric aggregates only, with no raw prefixes, sequence IDs,
paths or unrelated lines. Parser errors expose a line number, not its contents;
filesystem errors omit paths. Original serial logs can still contain coordinates
or other sensitive information. Keep them private and review every artifact
before sharing it. This is not a general-purpose log-redaction tool.

## API references and validation

The implementation was checked against the official Node.js APIs used by the
repository's Node 24 CI and the local Node.js 22.16.0 test runtime:

- [`fs.createReadStream`](https://nodejs.org/download/release/latest-v24.x/docs/api/fs.html#fscreatereadstreampath-options): encoding, chunk sizing and automatic descriptor cleanup.
- [`Readable[Symbol.asyncIterator]`](https://nodejs.org/download/release/latest-v24.x/docs/api/stream.html#readablesymbolasynciterator): sequential consumption and destruction when iteration exits with an error.
- [`pathToFileURL`](https://nodejs.org/download/release/latest-v24.x/docs/api/url.html#urlpathtofileurlpath-options): correctly encoded file URLs for the direct-entry guard.
- [`node:test`](https://nodejs.org/download/release/latest-v24.x/docs/api/test.html): asynchronous tests and per-test cleanup hooks.

All 21 focused tests pass locally on Node.js 22.16.0, including current and
legacy records, exact connection-attempt grouping, quantiles, malformed data,
empty captures, size/sample limits, stream errors, privacy and no partial output
on a later input failure. A separate generated-data check accepts exactly
100,000 records with the expected p99 and rejects the 100,001st record. Fixture
durations such as 4,400 ms are synthetic, not captured ESP32 benchmark results.
The root `npm test` command already includes `scripts/*.test.mjs`; no package or
lockfile edit is needed. Node 24 CI and full `npm run verify` remain separate
checks until GitHub reports them.

See [hardware telemetry](../hardware/HARDWARE_TELEMETRY.md) for the existing
runtime, queue and physical-acceptance contract. This analysis does not replace
board builds, certificate-rejection tests, watchdog/heap checks or a real route
trial.
