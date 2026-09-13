#pragma once

#include <cstddef>
#include <cstdint>

namespace eki {
namespace http {

constexpr int MAX_REUSABLE_RESPONSE_BYTES = 4096;
constexpr uint32_t RESPONSE_DRAIN_TIMEOUT_MS = 1000;

/* consume a bounded body without allocating a response-sized string. */
template <typename Client, typename Now, typename Idle>
bool drainResponseBody(Client &client, int contentLength, Now now, Idle idle) {
  if (contentLength < 0 || contentLength > MAX_REUSABLE_RESPONSE_BYTES) {
    return false;
  }

  const uint32_t startedAt = now();
  size_t remaining = static_cast<size_t>(contentLength);
  uint8_t buffer[128];
  while (remaining > 0) {
    /* use an absolute budget so partial arrivals cannot extend the drain. */
    if (static_cast<uint32_t>(now() - startedAt) >= RESPONSE_DRAIN_TIMEOUT_MS) {
      return false;
    }
    const int available = client.available();
    if (available < 0) return false;
    if (available == 0) {
      if (!client.connected()) return false;
      idle();
      continue;
    }

    size_t requested = remaining < sizeof(buffer) ? remaining : sizeof(buffer);
    if (static_cast<size_t>(available) < requested) {
      requested = static_cast<size_t>(available);
    }
    /* read only available bytes; readBytes would introduce another timeout. */
    const int count = client.read(buffer, requested);
    if (count < 0 || static_cast<size_t>(count) > requested) return false;
    if (count == 0) {
      idle();
      continue;
    }
    remaining -= static_cast<size_t>(count);
  }
  return true;
}

/* an accepted status remains accepted even when its socket cannot be reused. */
template <typename HttpClient, typename Client, typename Now, typename Idle>
bool finishResponse(
  HttpClient &http,
  Client &client,
  bool accepted,
  Now now,
  Idle idle
) {
  /* chunked and close-delimited responses use a fresh connection next time. */
  const bool complete = accepted &&
    http.header("Transfer-Encoding").length() == 0 &&
    drainResponseBody(client, http.getSize(), now, idle);
  http.setReuse(complete);
  if (!complete) client.stop();
  http.end();
  return complete && client.connected();
}

} /* namespace http */
} /* namespace eki */
