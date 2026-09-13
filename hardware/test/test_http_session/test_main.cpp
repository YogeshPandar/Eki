#include "http_session.h"

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <string>
#include <type_traits>

#ifndef EKI_STANDALONE_TEST
#include <unity.h>
#endif

namespace {

#ifdef EKI_STANDALONE_TEST
void check(bool condition, const char *expression, int line) {
  if (!condition) {
    std::fprintf(stderr, "line %d: %s\n", line, expression);
    std::exit(EXIT_FAILURE);
  }
}
#define CHECK(expression) check((expression), #expression, __LINE__)
#else
#define CHECK(expression) TEST_ASSERT_TRUE(expression)
#endif

struct Clock {
  static uint32_t tick;
  static uint32_t now() { return tick; }
  static void idle() { ++tick; }
};
uint32_t Clock::tick = 0;

struct Network {
  bool open = false;
  bool connectSucceeds = true;
  bool readFails = false;
  bool availableFails = false;
  bool closeAfterBody = false;
  uint32_t connects = 0;
  uint32_t stops = 0;
  uint32_t connectDelay = 40;
  uint32_t byteDelay = 0;
  uint32_t readCost = 0;
  uint32_t lastRead = 0;
  size_t readLimit = 128;
  size_t offset = 0;
  std::string bytes;
  std::string connectedHost;
  uint16_t connectedPort = 0;
  int32_t connectTimeout = 0;

  virtual ~Network() = default;
  virtual int connect(const char *host, uint16_t port, int32_t timeout) {
    ++connects;
    connectedHost = host;
    connectedPort = port;
    connectTimeout = timeout;
    Clock::tick += connectDelay;
    open = connectSucceeds;
    return open ? 1 : 0;
  }
  int connect(const char *host, uint16_t port) { return connect(host, port, 123); }
  void stop() { open = false; bytes.clear(); offset = 0; ++stops; }
  bool connected() { return open; }
  int available() {
    if (availableFails) return -1;
    if (!open || static_cast<uint32_t>(Clock::now() - lastRead) < byteDelay) return 0;
    return static_cast<int>(bytes.size() - offset);
  }
  int read(uint8_t *target, size_t count) {
    if (readFails) return -1;
    const size_t size = std::min(count, std::min(readLimit, bytes.size() - offset));
    std::memcpy(target, bytes.data() + offset, size);
    offset += size;
    Clock::tick += readCost;
    lastRead = Clock::now();
    if (closeAfterBody && offset == bytes.size()) open = false;
    return static_cast<int>(size);
  }
};

/* this double models the documented 2.0.17 ownership and response lifecycle. */
struct Http {
  static uint32_t destructions;
  Network *client = nullptr;
  bool reuse = true;
  bool serverClose = false;
  bool beginSucceeds = true;
  bool missingStream = false;
  int status = 202;
  int32_t connectTimeout = 0;
  uint16_t readTimeout = 0;
  uint32_t collections = 0;
  std::string length = "2";
  std::string encoding;
  std::string body = "{}";
  std::string endpoint;
  std::map<std::string, std::string> outgoing;
  std::map<std::string, std::string> sent;
  std::map<std::string, std::string> incoming;

  ~Http() { ++destructions; if (client != nullptr) client->stop(); }
  void setConnectTimeout(int32_t value) { connectTimeout = value; }
  void setTimeout(uint16_t value) { readTimeout = value; }
  void setReuse(bool value) { reuse = value; }
  void collectHeaders(const char *keys[], size_t count) {
    ++collections;
    CHECK(count == 3);
    CHECK(std::strcmp(keys[0], "Retry-After") == 0);
  }
  bool begin(Network &network, const char *url) {
    client = &network;
    endpoint = url;
    return beginSucceeds;
  }
  void addHeader(const char *key, const char *value) { outgoing[key] = value; }
  std::string header(const char *key) { return incoming[key]; }
  Network *getStreamPtr() { return missingStream ? nullptr : client; }
  void end() {
    if (client != nullptr && (!reuse || serverClose)) client->stop();
    outgoing.clear();
  }
  int POST() {
    incoming.clear();
    if (!client->connected() && !client->connect("backend.example", 443, connectTimeout)) return -1;
    sent = outgoing;
    client->bytes = body;
    client->offset = 0;
    client->lastRead = Clock::now();
    incoming["Content-Length"] = length;
    incoming["Transfer-Encoding"] = encoding;
    incoming["Retry-After"] = status == 429 ? "30" : "";
    return status;
  }
  int GET() { return POST(); }
};
uint32_t Http::destructions = 0;
using TimedNetwork = eki::http::TimedClient<Network, Clock>;
using Session = eki::http::BackendSession<Http, Network, Clock>;
constexpr const char *ORIGIN = "https://backend.example";
constexpr const char *TELEMETRY = "https://backend.example/api/devices/device/telemetry";
constexpr const char *DIAGNOSTICS = "https://backend.example/api/devices/device/diagnostics";
constexpr const char *MANIFEST = "https://backend.example/api/devices/device/firmware?sequence=1";

void persistentRequestsDoNotDestroyTheClient() {
  TimedNetwork network;
  const uint32_t before = Http::destructions;
  {
    Session session(network, ORIGIN, 7000);
    for (unsigned i = 0; i < 2000; ++i) {
      CHECK(session.begin(i % 2 == 0 ? TELEMETRY : DIAGNOSTICS));
      CHECK(session.finish(session.request().POST()));
      CHECK(network.open);
      CHECK(network.offset == network.bytes.size());
      CHECK(Http::destructions == before);
    }
    CHECK(network.connects == 1);
    CHECK(network.timing().attempts == 1);
    CHECK(session.request().collections == 1);
    CHECK(session.request().connectTimeout == 7000);
    CHECK(session.request().readTimeout == 7000);
  }
  CHECK(Http::destructions == before + 1);
  CHECK(!network.open);
}

void bodyIsConsumedAcrossPartialReads() {
  Network network;
  network.readLimit = 1;
  network.byteDelay = 3;
  Session session(network, ORIGIN, 7000);
  CHECK(session.begin(TELEMETRY));
  session.request().body = "{\"accepted\":true}";
  session.request().length = std::to_string(session.request().body.size());
  CHECK(session.finish(session.request().POST()));
  CHECK(session.responseBytes() == 17);
  CHECK(network.open);
}

void manifestCaptureIsBoundedAndTerminated() {
  Network network;
  Session session(network, ORIGIN, 7000);
  CHECK(session.begin(MANIFEST));
  session.request().status = 200;
  char body[3] = {'x', 'x', 'x'};
  CHECK(session.finish(session.request().GET(), body, sizeof(body)));
  CHECK(std::strcmp(body, "{}") == 0);
  CHECK(session.responseBytes() == 2);
  CHECK(session.begin(MANIFEST));
  char tooSmall[2] = {'x', 'y'};
  CHECK(!session.finish(session.request().GET(), tooSmall, sizeof(tooSmall)));
  CHECK(tooSmall[1] == 'y');
  CHECK(!network.open);
}

void maximumResponseFitsBoundedBuffer() {
  Network network;
  Session session(network, ORIGIN, 7000);
  CHECK(session.begin(MANIFEST));
  session.request().body.assign(eki::http::RESPONSE_BODY_LIMIT, 'a');
  session.request().length = std::to_string(session.request().body.size());
  char body[eki::http::RESPONSE_BODY_LIMIT + 1];
  CHECK(session.finish(session.request().GET(), body, sizeof(body)));
  CHECK(std::strlen(body) == eki::http::RESPONSE_BODY_LIMIT);
}

void responseLengthsAreStrictAndOverflowSafe() {
  size_t length = 0;
  for (size_t i = 0; i <= eki::http::RESPONSE_BODY_LIMIT; ++i) {
    const std::string text = std::to_string(i);
    CHECK(eki::http::responseBodyLength(202, text.c_str(), "", length));
    CHECK(length == i);
  }
  const char *invalid[] = {"", "-1", "+2", "2x", "2,2", " 2", "2 ", "4097", "9999999999999999999999999"};
  for (const char *text : invalid) {
    CHECK(!eki::http::responseBodyLength(202, text, "", length));
  }
  CHECK(!eki::http::responseBodyLength(202, nullptr, "", length));
  CHECK(!eki::http::responseBodyLength(202, "2", nullptr, length));
  CHECK(!eki::http::responseBodyLength(202, "2", "chunked", length));
  CHECK(!eki::http::responseBodyLength(202, "2", "identity", length));
  CHECK(eki::http::responseBodyLength(204, "", "", length));
  CHECK(eki::http::responseBodyLength(204, "0", "", length));
  CHECK(!eki::http::responseBodyLength(204, "2", "", length));
}

void unframedChunkedAndOversizedResponsesClose() {
  const char *lengths[] = {"", "4097", "invalid", "2"};
  for (unsigned i = 0; i < 4; ++i) {
    Network network;
    Session session(network, ORIGIN, 7000);
    CHECK(session.begin(TELEMETRY));
    session.request().length = lengths[i];
    session.request().encoding = i == 3 ? "chunked" : "";
    CHECK(!session.finish(session.request().POST()));
    CHECK(!network.open);
  }
}

void noContentDoesNotWaitForABody() {
  Network network;
  Session session(network, ORIGIN, 7000);
  CHECK(session.begin(MANIFEST));
  session.request().status = 204;
  session.request().body.clear();
  session.request().length.clear();
  const int status = session.request().GET();
  const uint32_t before = Clock::now();
  CHECK(session.finish(status));
  CHECK(Clock::now() == before);
  CHECK(network.open);
}

void truncatedBodyStopsAtTheTotalDeadline() {
  Network network;
  Session session(network, ORIGIN, 7000);
  CHECK(session.begin(TELEMETRY));
  session.request().length = "3";
  const int status = session.request().POST();
  const uint32_t before = Clock::now();
  CHECK(!session.finish(status));
  CHECK(Clock::now() - before == eki::http::RESPONSE_DRAIN_TIMEOUT_MS);
  CHECK(!network.open);
}

void slowDripDoesNotRestartTheDeadline() {
  Network network;
  network.readLimit = 1;
  network.byteDelay = 600;
  Session session(network, ORIGIN, 7000);
  CHECK(session.begin(TELEMETRY));
  const int status = session.request().POST();
  const uint32_t before = Clock::now();
  CHECK(!session.finish(status));
  CHECK(session.responseBytes() == 1);
  CHECK(Clock::now() - before == eki::http::RESPONSE_DRAIN_TIMEOUT_MS);
  CHECK(!network.open);
}

void finalReadCannotExceedTheDrainDeadline() {
  for (uint32_t cost : {999U, 1000U, 1001U}) {
    Network network;
    network.readCost = cost;
    Session session(network, ORIGIN, 7000);
    CHECK(session.begin(TELEMETRY));
    const int status = session.request().POST();
    const bool withinBudget = cost < eki::http::RESPONSE_DRAIN_TIMEOUT_MS;
    CHECK(session.finish(status) == withinBudget);
    CHECK(network.open == withinBudget);
  }
}

void drainDeadlineSurvivesClockRollover() {
  Network network;
  Session session(network, ORIGIN, 7000);
  CHECK(session.begin(TELEMETRY));
  session.request().length = "3";
  const int status = session.request().POST();
  Clock::tick = UINT32_MAX - 100;
  CHECK(!session.finish(status));
  CHECK(Clock::tick == eki::http::RESPONSE_DRAIN_TIMEOUT_MS - 101);
  CHECK(!network.open);
}

void streamErrorsAndEarlyDisconnectClose() {
  for (unsigned failure = 0; failure < 4; ++failure) {
    Network network;
    Session session(network, ORIGIN, 7000);
    CHECK(session.begin(TELEMETRY));
    const int status = session.request().POST();
    if (failure == 0) network.readFails = true;
    if (failure == 1) network.availableFails = true;
    if (failure == 2) network.open = false;
    if (failure == 3) session.request().missingStream = true;
    CHECK(!session.finish(status));
    CHECK(!network.open);
  }
}

void unexpectedTrailingBytesPreventReuse() {
  Network network;
  Session session(network, ORIGIN, 7000);
  CHECK(session.begin(TELEMETRY));
  session.request().body = "{}unexpected";
  CHECK(!session.finish(session.request().POST()));
  CHECK(!network.open);
}

void lateTrailingBytesAreNotSilentlyDiscarded() {
  Network network;
  Session session(network, ORIGIN, 7000);
  CHECK(session.begin(TELEMETRY));
  CHECK(session.finish(session.request().POST()));
  network.bytes += "unexpected";
  CHECK(session.begin(DIAGNOSTICS));
  CHECK(!network.open);
  CHECK(session.finish(session.request().POST()));
  CHECK(network.connects == 2);
}

void serverCloseAndWifiResetReconnectCleanly() {
  Network network;
  Session session(network, ORIGIN, 7000);
  CHECK(session.begin(TELEMETRY));
  session.request().serverClose = true;
  CHECK(session.finish(session.request().POST()));
  CHECK(!network.open);
  session.request().serverClose = false;
  CHECK(session.begin(TELEMETRY));
  CHECK(session.finish(session.request().POST()));
  CHECK(network.connects == 2);
  session.reset();
  CHECK(!network.open);
  CHECK(session.begin(TELEMETRY));
  CHECK(session.finish(session.request().POST()));
  CHECK(network.connects == 3);
}

void failedRequestsNeverRetainTheSocket() {
  const int codes[] = {-1, -11, 301, 307, 400, 401, 403, 404, 408, 413, 422, 429, 500, 503};
  for (int status : codes) {
    Network network;
    Session session(network, ORIGIN, 7000);
    CHECK(session.begin(TELEMETRY));
    session.request().status = status;
    CHECK(!session.finish(session.request().POST()));
    CHECK(!network.open);
    session.request().status = 202;
    CHECK(session.begin(TELEMETRY));
    CHECK(session.finish(session.request().POST()));
    CHECK(network.connects == 2);
  }
}

void headersAreClearedBetweenRequests() {
  Network network;
  Session session(network, ORIGIN, 7000);
  CHECK(session.begin(TELEMETRY));
  session.request().addHeader("Authorization", "Device test-only");
  session.request().addHeader("Content-Type", "application/json");
  CHECK(session.finish(session.request().POST()));
  CHECK(session.begin(MANIFEST));
  session.request().addHeader("Authorization", "Device replacement-test-only");
  CHECK(session.finish(session.request().GET()));
  CHECK(session.request().sent.size() == 1);
  CHECK(session.request().sent["Authorization"] == "Device replacement-test-only");
  CHECK(network.connects == 1);
}

void retryAfterIsAvailableBeforeCleanup() {
  Network network;
  Session session(network, ORIGIN, 7000);
  CHECK(session.begin(TELEMETRY));
  session.request().status = 429;
  const int status = session.request().POST();
  const std::string retryAfter = session.request().header("Retry-After");
  CHECK(!session.finish(status));
  CHECK(retryAfter == "30");
  session.request().status = 202;
  CHECK(session.begin(TELEMETRY));
  const int nextStatus = session.request().POST();
  CHECK(session.request().header("Retry-After").empty());
  CHECK(session.finish(nextStatus));
}

void abandonedOrFailedBeginCannotReusePendingData() {
  Network network;
  Session session(network, ORIGIN, 7000);
  CHECK(!session.finish(202));
  CHECK(session.begin(TELEMETRY));
  session.request().POST();
  CHECK(session.begin(DIAGNOSTICS));
  CHECK(!network.open);
  CHECK(session.finish(session.request().POST()));
  session.request().beginSucceeds = false;
  CHECK(!session.begin(TELEMETRY));
  CHECK(!network.open);
}

void fixedOriginRejectsCredentialForwarding() {
  const char *urls[] = {
    nullptr, "", "https://other.example/api", "http://backend.example/api",
    "https://backend.example:444/api", "https://backend.example.evil/api",
    "https://backend.example@other.example/api", "https://backend.example",
    "https://backend.example?query", "https://backend.exam"
  };
  for (const char *url : urls) {
    Network network;
    Session session(network, ORIGIN, 7000);
    CHECK(!session.begin(url));
    CHECK(network.connects == 0);
  }
  Network network;
  Session trailingSlash(network, "https://backend.example///", 7000);
  CHECK(trailingSlash.begin(TELEMETRY));
  CHECK(trailingSlash.finish(trailingSlash.request().POST()));
  Session empty(network, nullptr, 7000);
  CHECK(!empty.begin(TELEMETRY));
}

void connectionTimingForwardsArgumentsAndIncludesFailures() {
  TimedNetwork network;
  Network &base = network;
  Clock::tick = UINT32_MAX - 20;
  network.connectDelay = 40;
  CHECK(base.connect("backend.example", 443, 7000) == 1);
  CHECK(network.timing().attempts == 1);
  CHECK(network.timing().durationMs == 40);
  CHECK(network.connectedHost == "backend.example");
  CHECK(network.connectedPort == 443);
  CHECK(network.connectTimeout == 7000);
  network.stop();
  network.connectSucceeds = false;
  CHECK(base.connect("backend.example", 443, 7000) == 0);
  CHECK(network.timing().attempts == 2);
  CHECK(network.timing().durationMs == 40);
  CHECK(network.connect("backend.example", 443) == 0);
  CHECK(network.connectTimeout == 123);
}

static_assert(!std::is_copy_constructible<Session>::value, "session ownership cannot be copied");
static_assert(!std::is_copy_assignable<Session>::value, "session ownership cannot be assigned");

} /* namespace */

#ifndef EKI_STANDALONE_TEST
void setUp() { Clock::tick = 0; }
void tearDown() {}
#endif

int main() {
#ifdef EKI_STANDALONE_TEST
  const struct { const char *name; void (*run)(); } tests[] = {
    {"persistent requests", persistentRequestsDoNotDestroyTheClient},
    {"partial response reads", bodyIsConsumedAcrossPartialReads},
    {"manifest bounds", manifestCaptureIsBoundedAndTerminated},
    {"maximum response", maximumResponseFitsBoundedBuffer},
    {"strict framing lengths", responseLengthsAreStrictAndOverflowSafe},
    {"unframed fallback", unframedChunkedAndOversizedResponsesClose},
    {"empty response", noContentDoesNotWaitForABody},
    {"truncated response deadline", truncatedBodyStopsAtTheTotalDeadline},
    {"slow drip deadline", slowDripDoesNotRestartTheDeadline},
    {"final read deadline", finalReadCannotExceedTheDrainDeadline},
    {"clock rollover", drainDeadlineSurvivesClockRollover},
    {"stream failures", streamErrorsAndEarlyDisconnectClose},
    {"unexpected bytes", unexpectedTrailingBytesPreventReuse},
    {"late unexpected bytes", lateTrailingBytesAreNotSilentlyDiscarded},
    {"server and wifi close", serverCloseAndWifiResetReconnectCleanly},
    {"failed status cleanup", failedRequestsNeverRetainTheSocket},
    {"request header cleanup", headersAreClearedBetweenRequests},
    {"retry-after cleanup", retryAfterIsAvailableBeforeCleanup},
    {"abandoned request", abandonedOrFailedBeginCannotReusePendingData},
    {"fixed origin", fixedOriginRejectsCredentialForwarding},
    {"connect timing", connectionTimingForwardsArgumentsAndIncludesFailures},
  };
  for (const auto &test : tests) {
    Clock::tick = 0;
    test.run();
    std::printf("PASS %s\n", test.name);
  }
  std::printf("%zu host regression tests passed\n", sizeof(tests) / sizeof(tests[0]));
#else
  UNITY_BEGIN();
  RUN_TEST(persistentRequestsDoNotDestroyTheClient);
  RUN_TEST(bodyIsConsumedAcrossPartialReads);
  RUN_TEST(manifestCaptureIsBoundedAndTerminated);
  RUN_TEST(maximumResponseFitsBoundedBuffer);
  RUN_TEST(responseLengthsAreStrictAndOverflowSafe);
  RUN_TEST(unframedChunkedAndOversizedResponsesClose);
  RUN_TEST(noContentDoesNotWaitForABody);
  RUN_TEST(truncatedBodyStopsAtTheTotalDeadline);
  RUN_TEST(slowDripDoesNotRestartTheDeadline);
  RUN_TEST(finalReadCannotExceedTheDrainDeadline);
  RUN_TEST(drainDeadlineSurvivesClockRollover);
  RUN_TEST(streamErrorsAndEarlyDisconnectClose);
  RUN_TEST(unexpectedTrailingBytesPreventReuse);
  RUN_TEST(lateTrailingBytesAreNotSilentlyDiscarded);
  RUN_TEST(serverCloseAndWifiResetReconnectCleanly);
  RUN_TEST(failedRequestsNeverRetainTheSocket);
  RUN_TEST(headersAreClearedBetweenRequests);
  RUN_TEST(retryAfterIsAvailableBeforeCleanup);
  RUN_TEST(abandonedOrFailedBeginCannotReusePendingData);
  RUN_TEST(fixedOriginRejectsCredentialForwarding);
  RUN_TEST(connectionTimingForwardsArgumentsAndIncludesFailures);
  return UNITY_END();
#endif
}
