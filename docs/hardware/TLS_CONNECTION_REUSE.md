# Firmware HTTPS connection reuse

## Scope and baseline

Based on `main` at `1eb7501140cf8f244275a25d0bda5a0050c79749`.
This fixes repeated connection teardown and supplies measurement hooks for
upstream [#159](https://github.com/notnamansinha/Eki/issues/159) and
[#168](https://github.com/notnamansinha/Eki/issues/168). It does not complete
real-drive acceptance. The reported 4.4-second delay is not a reproduced
benchmark, and no numerical speedup is claimed.

## Version-matched API review

The [PlatformIO 7.0.1 manifest](https://github.com/platformio/platform-espressif32/blob/v7.0.1/platform.json)
selects Arduino-ESP32 `~3.20017.0` (core 2.0.17). The following function
contracts were checked against their actual definitions rather than core 3.x:

| API | Relevant behavior |
| --- | --- |
| [`HTTPClient::~HTTPClient`, `beginInternal`, `end`, `disconnect`, `setReuse`](https://github.com/espressif/arduino-esp32/blob/2.0.17/libraries/HTTPClient/src/HTTPClient.cpp) | The destructor stops the transport even after `end()` retains it. A new parser can also disconnect on a stored-host change. Retain one parser and clear outgoing headers with `end()` after consuming the body. |
| [`HTTPClient::collectHeaders`, `sendRequest`, `handleHeaderResponse`, `getStreamPtr`](https://github.com/espressif/arduino-esp32/blob/2.0.17/libraries/HTTPClient/src/HTTPClient.cpp) | Collected keys are copied; GET/POST clear their previous values. Headers arrive before the body. A disconnected stream can be null. HTTP/1.0 and server close affect reuse. |
| [`WiFiClientSecure::flush`, `available`, `read`](https://github.com/espressif/arduino-esp32/blob/2.0.17/libraries/WiFiClientSecure/src/WiFiClientSecure.h) | Secure `flush()` is empty. Read only available bytes; do not assume all fragments arrived with the headers. |
| [`WiFiClientSecure::setCACert`, `setHandshakeTimeout`, `connect`](https://github.com/espressif/arduino-esp32/blob/2.0.17/libraries/WiFiClientSecure/src/WiFiClientSecure.cpp) | CA verification remains enabled. The handshake setter takes seconds. The hostname/port/timeout overload includes DNS, TCP and TLS. |
| [`WiFiClient` / `ESPLwIPClient::connect`](https://github.com/espressif/arduino-esp32/blob/2.0.17/libraries/WiFi/src/WiFiClient.h) | The three-argument hostname overload is virtual. `HTTPClient::connect()` calls it, allowing actual connection-attempt counting without modifying TLS internals. |
| [`deserializeJson(document, const char*, size_t)`](https://arduinojson.org/v7/api/json/deserializejson/) | Parse a complete, bounded manifest buffer using an explicit byte length. No pointers into the document escape the existing manifest-copy checks. |

## Ownership and response boundary

`backendSession` owns one HTTP parser for telemetry POSTs, diagnostic POSTs and
fleet manifest GETs. The network clients and immutable backend origin outlive
it. Only the publisher task uses it after setup; no lock spans network work.
The header table is allocated once on the first request. Every request adds
its own authorization and payload headers after the previous `end()` cleared
them. Copying the session is forbidden.

Endpoints must match the configured origin exactly, including scheme and port.
Redirect following remains disabled. A rejected begin, an abandoned response,
unexpected buffered bytes, Wi-Fi loss or credential lockout resets the session.
This also closes late data before `HTTPClient::connect()` could silently discard
it. Artifact URLs never pass through the authenticated backend session.

Only accepted, explicitly length-delimited bodies of at most 4096 bytes can
retain the connection. The raw Content-Length value must contain only decimal
digits within the cap; the helper does not trust the library's integer
conversion alone. Chunked, close-delimited, malformed, oversized and incomplete
responses close instead. The pinned library still owns HTTP header parsing;
this helper is not a replacement parser or a claim to detect duplicate wire
headers that the library does not expose.

Cleanup uses a 128-byte stack buffer and one 1000 ms monotonic deadline, including
fragment gaps. The final read is checked against the same deadline; SDK calls
are not preempted by this helper. These are defensive cleanup caps, not measured latency targets.
A 204 manifest response needs no body. A 200 manifest is completely captured
within its existing 1024-byte limit before JSON parsing. Complete bodies remain
usable even when the peer closes the connection afterward. Unknown framing or
failed parsing cannot authorize an update.

An accepted telemetry status still acknowledges the fix when body cleanup
fails: the server may already have durably accepted it. Cleanup failure changes
connection reuse, not ingestion outcome. Only 200/202 acknowledge telemetry;
credential lockout, Retry-After, latest-sample ordering, freshness and retry
jitter remain intact. There is no hidden POST replay.

Manifest checks no longer destroy the warm telemetry socket. An actual signed
artifact download still deliberately releases backend TLS memory and uses the
separate unauthenticated artifact client. Signing, digest validation, rollback
and active-ride update restrictions are unchanged.

Both secure clients receive a seven-second handshake-phase limit using the
seconds-based setter. This is not an overall seven-second request deadline:
DNS, TCP, TLS, writes, header reads and body cleanup have distinct behavior.
GNSS capture remains on its separate task.

This optimization is HTTP connection reuse, not TLS session-ticket resumption.
It avoids repeated setup while a validated connection stays open; it does not
make the first certificate validation cheaper or prevent a proxy from closing
idle sockets. CA, hostname and time validation are not bypassed.

## Measurement

Append `-D EKI_TRANSPORT_METRICS=1` to the selected environment's existing build
flags for a bench build. Extra timing output is off by default. Preserve every
other build flag. Each attempted telemetry POST emits:

```text
[Transport] seq=<n> status=<code> socket_open_before=<0|1> headers_ms=<n> total_ms=<n> reusable=<0|1> connect_attempts=<n> connect_ms=<n>
```

`headers_ms` spans POST through response headers, including any connection setup,
upload and backend work. `total_ms` additionally includes response cleanup.
Both are captured before serial logging. `socket_open_before` is only a reuse
candidate; the peer may close between checks. `reusable` means the complete
body was consumed and the client still reported connected.

`connect_attempts` is the change in actual calls to the pinned hostname/port/
timeout overload. `connect_ms` is zero when no call occurred, otherwise the
latest call's elapsed duration, including DNS/TCP/TLS and failures. Redirects
are disabled, so the current request path has at most one such call. These
fields do not isolate certificate verification, prove TLS ticket resumption,
or substitute for packet/proxy observations of the TLS exchange.

The companion latency analyzer accepts older records without the two new
fields; do not treat missing observations as zero connection cost. No secrets
or coordinates are added to these records. Existing serial output can contain
coordinates and must be redacted before sharing.

Compare identically instrumented baseline and changed builds on the same board,
network and backend. Capture cold starts, sustained motion, stopped heartbeat
intervals, diagnostics, manifest checks, peer close and Wi-Fi reconnection.
Report counts and p50/p95/p99 separately for requests with and without observed
connect calls. Correlate sequence IDs with server/RTDB/browser evidence from
#159. Do not infer elapsed TLS time from unsynchronized wall clocks or interpret
intentional five-second stopped heartbeats as transport failure.

## Validation

Twenty-one host cases exercise the production session template with an explicit
model of the reviewed HTTPClient lifecycle. They cover 2000 consecutive requests
on one modeled connection, fragmented bodies, capture bounds, strict lengths,
unsupported framing, no-content responses, truncation, slow drip, clock rollover,
last-read deadline boundaries, stream failures, early/late trailing bytes, peer close, Wi-Fi reset, error status
cleanup, header reuse, Retry-After, abandoned requests, origin isolation and
virtual connection-timing dispatch. They do not emulate ESP32 TLS.

Run the native suite and both board builds using the repository's existing CI:

```sh
platformio test --project-dir hardware -e native
platformio run --project-dir hardware -e esp32dev
platformio run --project-dir hardware -e esp32dev-secure
```

The signed build requires the documented CI-only key/configuration; never use
production signing material in an untrusted build environment or upload an
image as part of testing this PR.

The dependency-free test mode was executed successfully with both compilers:

```sh
for compiler in g++ clang++; do
  "$compiler" -std=c++11 -Wall -Wextra -Werror -pedantic \
    -O1 -g -fsanitize=address,undefined -fno-omit-frame-pointer \
    -DEKI_STANDALONE_TEST -Ihardware/include \
    hardware/test/test_http_session/test_main.cpp -o /tmp/eki-http-session-test
  /tmp/eki-http-session-test
done
```

Local DNS prevented installing PlatformIO and the full dependency tree. No full
board build, repository verification or physical latency measurement is claimed.
Before release, require confirmed CI results and staging-device evidence for:

- Reuse across telemetry, diagnostics and 204/200 manifest responses; peer close,
  stopped idle periods and an actual artifact download.
- Fragmented, truncated, chunked, oversized and delayed bodies without response
  contamination, duplicate acknowledgements or stale-sample replay.
- CA/hostname/expiry/time rejection, credential lockout, Retry-After and recovery
  after Wi-Fi or backend loss.
- Sustained free heap, largest free block, publisher stack high-water mark,
  watchdog health and GNSS UART counters during reuse/reconnection soak tests.

Keep first-handshake crypto tuning, backend/RTDB latency, deployment regions and
proxy idle-timeout changes in separately measured workstreams.
