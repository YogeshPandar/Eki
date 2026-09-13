# Firmware HTTPS connection reuse

## Scope and baseline

Based on `main` at `1eb7501140cf8f244275a25d0bda5a0050c79749`.
This fixes repeated connection teardown in the firmware and supplies measurement
hooks for upstream [#159](https://github.com/notnamansinha/Eki/issues/159) and
[#168](https://github.com/notnamansinha/Eki/issues/168). It does not complete their
real-drive acceptance criteria. The reported 4.4-second TLS/certificate delay is
not a benchmark reproduced by this change.

## Verified library behavior

The [pinned platform manifest](https://github.com/platformio/platform-espressif32/blob/v7.0.1/platform.json)
selects Arduino-ESP32 `~3.20017.0` (core 2.0.17). The implementation was checked
against these versioned upstream function definitions, rather than core 3.x APIs:

| API | Behavior relevant to this fix |
| --- | --- |
| [`HTTPClient::~HTTPClient`, `beginInternal`, `end`, `disconnect`, `setReuse`](https://github.com/espressif/arduino-esp32/blob/2.0.17/libraries/HTTPClient/src/HTTPClient.cpp) | The destructor stops the transport even when `end()` retained it for reuse. A new HTTP object can also disconnect an existing client when its stored host changes. One long-lived object retains the same-origin connection; `end()` clears outgoing request state. |
| [`HTTPClient::sendRequest`, `handleHeaderResponse`](https://github.com/espressif/arduino-esp32/blob/2.0.17/libraries/HTTPClient/src/HTTPClient.cpp) | POST resets collected response-header values on every request. Headers are returned before the response body is consumed. The library tracks HTTP/1.0 and server `Connection: close` when deciding reuse. |
| [`WiFiClientSecure::flush`, `available`, `read`](https://github.com/espressif/arduino-esp32/blob/2.0.17/libraries/WiFiClientSecure/src/WiFiClientSecure.h) | Secure `flush()` is empty; it cannot drain a response. Read only the reported available bytes, including fragments that arrive after the headers. |
| [`WiFiClientSecure::setCACert`, `setHandshakeTimeout`](https://github.com/espressif/arduino-esp32/blob/2.0.17/libraries/WiFiClientSecure/src/WiFiClientSecure.cpp) | CA validation remains enabled. Handshake timeout takes seconds, unlike HTTPClient's millisecond timeouts. |

## Ownership and response boundary

`backendHttp` is configured before task creation and subsequently used only by
the publisher task. Telemetry and diagnostic POSTs share it and the existing
backend transport. No lock is held across network work. GNSS acquisition,
newest-first queue behavior, sample ordering, retry jitter and credential-fault
handling are unchanged.

Only accepted, length-delimited responses of at most 4096 bytes are drained for
reuse. The helper uses a 128-byte stack buffer and a single 1000 ms elapsed-time
budget, not a fresh timeout per fragment. These are defensive body-drain caps,
not measured network latency targets. Current backend success bodies are small
JSON acknowledgements. Chunked/unknown-length/oversized bodies, incomplete
bodies and failed requests close the connection instead of risking leftover
bytes in the next response. `Connection: close` remains the server's decision.

Receiving an accepted HTTP status still acknowledges the sample if body draining
fails: the server may already have durably accepted it. Reuse failure only closes
the socket; it does not invent a failed ingestion or bypass the existing status
and retry policy. A stale idle connection may fail on the next request; the
existing bounded latest-sample retry path handles that, without a hidden POST
replay inside the transport helper.

The fleet manifest path still uses its existing short-lived HTTP client, which
can intentionally close the backend connection. Artifact downloads retain their
separate TLS client. OTA signing, digest, rollback and credential isolation are
not changed. Both secure transports receive a seven-second handshake-phase
limit. This is **not** a seven-second end-to-end request deadline: DNS, TCP,
TLS, writes, headers and response draining have distinct timing behavior.

The optimization is HTTP connection reuse, **not TLS session resumption**. It
avoids additional handshakes while a validated connection stays open; it does
not accelerate the first handshake, cache certificates insecurely, disable
hostname/chain validation, or prevent a proxy from closing idle connections.

## Measurement

Extra serial timing output is disabled by default. Append
`-D EKI_TRANSPORT_METRICS=1` to the selected environment's existing `build_flags`
for a bench build; preserve its other flags. Each attempted telemetry POST emits:

```text
[Transport] seq=<n> status=<code> socket_open_before=<0|1> headers_ms=<n> total_ms=<n> reusable=<0|1>
```

`headers_ms` is elapsed `millis()` time through POST/header processing, including
any DNS/TCP/TLS setup, upload and backend processing. `total_ms` also includes
response cleanup; both are sampled before serial logging. `socket_open_before`
is only a reuse candidate: the peer can have silently closed it. `reusable`
means cleanup completed and the transport still reported connected, not proof
that the next request will reuse it. Neither flag proves TLS session resumption.
No credentials or coordinates are added to these records. Existing serial
output can contain coordinates; redact it before sharing.

Compare a baseline build instrumented at the same boundaries with this change
on the same board, network and backend. Record sample count and p50/p95/p99 for
cold starts, sustained moving telemetry, stopped heartbeat intervals, diagnostics,
network loss and reconnects. Confirm connection/handshake counts separately with
staging proxy connection logs or a controlled packet capture. Correlate sequence
IDs with backend and browser measurements from #159. Do not infer TLS-only
latency by subtracting unsynchronized wall clocks or count intentional stopped
heartbeat gaps as delivery failures.

## Validation

Host tests exercise the response helper and an explicit model of the pinned
HTTPClient lifetime; they do not emulate the ESP32 TLS stack. Seventeen cases
cover fragmentation, size bounds, peer close, partial bodies, nonprogress,
elapsed-time rollover, deadline boundaries, teardown on failure, persistent
versus request-local lifetime, server refusal and reconnect recovery.

Run the existing PlatformIO native suite:

```sh
platformio test --project-dir hardware -e native
```

A dependency-free sanitizer run of this test is also available:

```sh
for compiler in g++ clang++; do
  "$compiler" -std=c++11 -Wall -Wextra -Werror -pedantic \
    -fsanitize=address,undefined -fno-omit-frame-pointer \
    -DEKI_STANDALONE_TEST -Ihardware/include \
    hardware/test/test_http_session/test_main.cpp -o /tmp/eki-http-session-test
  /tmp/eki-http-session-test
done
```

The latter passed with both compilers during implementation. Full firmware
compilation and physical acceptance are separate gates; this result is not a
claim that a real 4.4-second delay has been reduced to a measured value.

Before fleet release, require both `esp32dev` and `esp32dev-secure` CI builds,
and validate these cases on a dedicated staging device:

- Continuous accepted POSTs reuse one connection when the peer permits it;
  diagnostics do not force a disconnect. Check stopped idle periods and OTA
  manifest checks separately.
- Fragmented, chunked, large, truncated and delayed acknowledgements never
  contaminate the next request. Accepted status plus truncated body still
  acknowledges exactly once, then reconnects.
- `401`/`403` still halt credentials; `429` still respects Retry-After; 5xx,
  timeout, peer restart and Wi-Fi loss retain bounded, fresh-sample recovery.
- Wrong CA, hostname mismatch, expired/not-yet-valid certificate and invalid
  device time remain rejected. Capture correct cold-handshake timeout behavior.
- Confirm GPS UART overflow counters, publisher watchdog behavior, free heap and
  largest free block remain healthy during a sustained reuse/reconnect soak.

Keep backend/RTDB latency, first-handshake crypto cost, deployment-region choices
and proxy idle-timeout changes in measured, separately reviewed workstreams.
