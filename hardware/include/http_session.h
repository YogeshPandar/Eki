#pragma once

#include <cstddef>
#include <cstdint>
#include <cstring>

namespace eki {
namespace http {

constexpr size_t RESPONSE_BODY_LIMIT = 4096;
constexpr uint32_t RESPONSE_DRAIN_TIMEOUT_MS = 1000;

inline bool responseBodyLength(
  int status,
  const char *contentLength,
  const char *transferEncoding,
  size_t &length
) {
  length = 0;
  /* only bounded, explicitly framed success responses may retain the socket. */
  if (status < 200 || status >= 300 || transferEncoding == nullptr ||
      transferEncoding[0] != '\0' || contentLength == nullptr) return false;
  if (contentLength[0] == '\0') return status == 204;
  for (const char *cursor = contentLength; *cursor != '\0'; ++cursor) {
    if (*cursor < '0' || *cursor > '9') return false;
    const size_t digit = static_cast<size_t>(*cursor - '0');
    if (length > (RESPONSE_BODY_LIMIT - digit) / 10) return false;
    length = length * 10 + digit;
  }
  return status != 204 || length == 0;
}

/* the client and fixed origin outlive this single-publisher session. */
template <typename HttpClient, typename NetworkClient, typename Clock>
class BackendSession {
public:
  BackendSession(NetworkClient &client, const char *origin, uint16_t timeoutMs)
      : client_(client), origin_(origin), timeoutMs_(timeoutMs) {
    originLength_ = origin == nullptr ? 0 : std::strlen(origin);
    while (originLength_ > 0 && origin[originLength_ - 1] == '/') --originLength_;
  }

  BackendSession(const BackendSession &) = delete;
  BackendSession &operator=(const BackendSession &) = delete;

  bool begin(const char *endpoint) {
    if (active_ || client_.available() != 0) reset();
    /* do not reuse authentication or transport across origins, ports or schemes. */
    if (endpoint == nullptr || originLength_ == 0 ||
        std::strncmp(endpoint, origin_, originLength_) != 0 ||
        endpoint[originLength_] != '/') {
      reset();
      return false;
    }
    if (!configured_) {
      http_.setConnectTimeout(timeoutMs_);
      http_.setTimeout(timeoutMs_);
      const char *headers[] = {"Retry-After", "Content-Length", "Transfer-Encoding"};
      http_.collectHeaders(headers, 3);
      configured_ = true;
    }
    http_.setReuse(true);
    if (!http_.begin(client_, endpoint)) {
      reset();
      return false;
    }
    active_ = true;
    responseBytes_ = 0;
    return true;
  }

  HttpClient &request() { return http_; }
  size_t responseBytes() const { return responseBytes_; }

  /* a failed drain closes the transport without undoing a received acceptance. */
  bool finish(int status, char *body = nullptr, size_t capacity = 0) {
    responseBytes_ = 0;
    if (body != nullptr && capacity > 0) body[0] = '\0';
    size_t length = 0;
    if (!active_ || !responseBodyLength(
          status,
          http_.header("Content-Length").c_str(),
          http_.header("Transfer-Encoding").c_str(),
          length
        ) || (body != nullptr && capacity <= length)) {
      reset();
      return false;
    }

    auto *stream = http_.getStreamPtr();
    if (length > 0 && stream == nullptr) {
      reset();
      return false;
    }
    uint8_t scratch[128];
    const uint32_t startedAt = Clock::now();
    while (responseBytes_ < length) {
      /* use a total deadline; intermittent bytes must not extend the drain. */
      if (static_cast<uint32_t>(Clock::now() - startedAt) >= RESPONSE_DRAIN_TIMEOUT_MS) {
        reset();
        return false;
      }
      const int available = stream->available();
      if (available < 0 || (available == 0 && !stream->connected())) {
        reset();
        return false;
      }
      if (available == 0) {
        Clock::idle();
        continue;
      }
      size_t count = length - responseBytes_;
      if (count > sizeof(scratch)) count = sizeof(scratch);
      if (count > static_cast<size_t>(available)) count = static_cast<size_t>(available);
      uint8_t *target = body == nullptr
        ? scratch
        : reinterpret_cast<uint8_t *>(body + responseBytes_);
      const int received = stream->read(target, count);
      if (received <= 0 || static_cast<size_t>(received) > count) {
        reset();
        return false;
      }
      responseBytes_ += static_cast<size_t>(received);
    }
    if (length > 0 &&
        static_cast<uint32_t>(Clock::now() - startedAt) >= RESPONSE_DRAIN_TIMEOUT_MS) {
      reset();
      return false;
    }
    if (body != nullptr) body[responseBytes_] = '\0';
    /* never pass buffered bytes from an unexpected response to the next request. */
    if (stream != nullptr && stream->available() > 0) {
      reset();
      return false;
    }
    http_.end();
    active_ = false;
    return true;
  }

  void reset() {
    http_.setReuse(false);
    http_.end();
    client_.stop();
    active_ = false;
  }

private:
  NetworkClient &client_;
  HttpClient http_;
  const char *origin_;
  size_t originLength_ = 0;
  uint16_t timeoutMs_;
  bool configured_ = false;
  bool active_ = false;
  size_t responseBytes_ = 0;
};

struct ConnectTiming {
  uint32_t attempts = 0;
  uint32_t durationMs = 0;
};

/* measure the actual connect overload used by arduino httpclient. */
template <typename Client, typename Clock>
class TimedClient : public Client {
public:
  using Client::connect;

  int connect(const char *host, uint16_t port, int32_t timeout) override {
    ++timing_.attempts;
    const uint32_t startedAt = Clock::now();
    const int result = Client::connect(host, port, timeout);
    timing_.durationMs = static_cast<uint32_t>(Clock::now() - startedAt);
    return result;
  }

  const ConnectTiming &timing() const { return timing_; }

private:
  ConnectTiming timing_;
};

} /* namespace http */
} /* namespace eki */
