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
A baseline without these records cannot be analyzed by this tool.

Save completed, UTF-8 serial captures as ordinary local files, then run:

```sh
node scripts/analyze-transport-latency.mjs before.log after.log > comparison.json
node --test scripts/analyze-transport-latency.test.mjs
```

Inputs are analyzed independently and identified by argument position (`input: 1`,
`input: 2`, and so on), not by their private paths. Their records are never pooled.
The JSON is emitted only after every input succeeds. Exit code 2 means invalid
usage, unreadable input, malformed records, exceeded limits or no matching data;
there is no partial success report. Shell redirection can still create an empty
output file on failure, so check the exit status before publishing the result.

Accepted record shape:

```text
[Transport] seq=<uint32> status=<http-or-negative-transport-code> socket_open_before=<0|1> headers_ms=<uint32> total_ms=<uint32> reusable=<0|1>
```

Monitor prefixes, CRLF, fragmented reads and an unterminated final record are
supported. Unrelated lines are counted but not retained. A line containing the
marker must match the complete record; trailing fields, invalid flags and
inconsistent ranges fail rather than silently bias the capture. `total_ms` must
be at least `headers_ms`. Repeated sequence IDs remain separate attempts because
retries are relevant measurements, not accidental duplicate samples.

## Report meaning

Every capture includes its sample count, ignored-line count, status counts and
these four groups:

| Group | Meaning |
| --- | --- |
| `accepted_socket_closed` | HTTP 200/202; socket reported closed before POST |
| `accepted_socket_open_candidate` | HTTP 200/202; socket reported open before POST |
| `nonaccepted_socket_closed` | Other HTTP status or negative transport error; socket reported closed |
| `nonaccepted_socket_open_candidate` | Other HTTP status or negative transport error; socket reported open |

Each group reports count, `retainedAfterResponse`, and minimum, p50, p95, p99 and
maximum for `headersMs`, `cleanupMs` and `totalMs`. Cleanup is `total - headers`.
Percentiles use the observed value at rank `ceil(p * count / 100)`, with ranks
starting at one. Empty groups have count zero and null distributions. Small
sample counts are not evidence of a stable tail percentile.

`headers_ms` includes any DNS/TCP/TLS setup, upload, backend work and HTTP header
processing. `total_ms` also includes response cleanup; neither measures TLS in
isolation. `socket_open_before=1` is only a reuse candidate because the peer may
have silently closed it. `reusable=1` means the helper finished cleanup and the
transport still reported connected; it does not prove the next request reuses
the socket. A closed socket does not prove a cold certificate cache. This tool
therefore does not label groups as verified cold/resumed TLS handshakes or
calculate a causal speedup from mixed network conditions.

Use the same board, backend, instrumentation and comparable radio conditions for
before/after captures. Separate startup, continuous moving telemetry, stopped
heartbeats, diagnostics, reconnects and OTA checks. Record firmware hashes,
sample counts and conditions alongside the report. Confirm actual TLS handshake
counts using staging proxy connection logs or a controlled capture, and correlate
backend processing/RTDB and browser measurements separately. Do not interpret
intentional stopped heartbeat gaps as dropped moving telemetry.

## Bounds and privacy

Each input is limited to 100,000 transport records, 4,096 UTF-16 code units per
line and 64 MiB of decoded text measured as UTF-8 bytes. The file reader uses
64 KiB chunks, bounds partial lines and closes its stream on completion or
failure. Limits reject an input rather than silently truncating it. Exact
percentiles retain bounded numeric records and sort per-group arrays; the tool
does not pretend to offer an unbounded, constant-memory quantile algorithm.

Use completed ordinary files, not an active serial device or a never-ending
pipe. The JSON contains numeric aggregates only, with no raw prefixes, sequence
IDs, paths or unrelated lines. Parser errors expose a line number, not its
contents; filesystem errors omit paths. Original serial logs can still contain
coordinates or other sensitive information: keep them private and review every
artifact before sharing it. This is not a general-purpose log redaction tool.

## API references and validation

The implementation was checked against the official documentation matching the
local test runtime, Node.js 22.16.0:

- [`fs.createReadStream`](https://nodejs.org/download/release/v22.16.0/docs/api/fs.html#fscreatereadstreampath-options): encoding, chunk sizing and automatic descriptor cleanup.
- [`Readable[Symbol.asyncIterator]`](https://nodejs.org/download/release/v22.16.0/docs/api/stream.html#readablesymbolasynciterator): sequential consumption and stream destruction when iteration exits early.
- [`pathToFileURL`](https://nodejs.org/download/release/v22.16.0/docs/api/url.html#urlpathtofileurlpath-options): correctly encoded file URLs for the direct-entry guard.
- [`node:test`](https://nodejs.org/download/release/v22.16.0/docs/api/test.html): asynchronous tests and cleanup hooks for temporary files.

All 18 tests pass on that runtime, including real file/CLI tests, exact quantiles,
malformed records, empty captures, size/sample limits, stream errors, privacy and
no partial output on a later input failure. Test durations such as 4,400 ms are
synthetic fixtures, not captured ESP32 benchmark results. The root `npm test`
command already includes `scripts/*.test.mjs`; no package or lockfile edit is
needed. The repository's Node 24 CI and full `npm run verify` remain separate
checks and were not run locally.

See [hardware telemetry](../hardware/HARDWARE_TELEMETRY.md) for the existing
runtime, queue and physical-acceptance contract. This analysis does not replace
board builds, certificate-rejection tests, watchdog/heap checks or a real route
trial.
