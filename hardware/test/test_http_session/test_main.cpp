#include "http_session.h"
#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

#ifdef EKI_STANDALONE_TEST
static unsigned testsRun = 0;
#define TEST_ASSERT_TRUE(value) do { \
  if (!(value)) { \
    std::fprintf(stderr, "%s:%d: %s\n", __FILE__, __LINE__, #value); \
    std::abort(); \
  } \
} while (false)
#define TEST_ASSERT_FALSE(value) TEST_ASSERT_TRUE(!(value))
#define TEST_ASSERT_EQUAL(expected, actual) TEST_ASSERT_TRUE((expected) == (actual))
#define RUN_TEST(test) do { test(); ++testsRun; } while (false)
#else
#include <unity.h>
#endif

namespace {
struct Clock {
  uint32_t time = 0;
  uint32_t waits = 0;
  uint32_t now() const { return time; }
  void idle() { ++time; ++waits; }
};

struct Fragment {
  uint32_t at;
  size_t size;
};

struct Client {
  Clock &clock;
  uint32_t startedAt;
  std::vector<Fragment> fragments;
  size_t consumed = 0;
  size_t maxRead = 0;
  unsigned stops = 0;
  unsigned connections = 0;
  bool open = true;
  bool failAvailable = false;
  bool failRead = false;
  bool zeroRead = false;
  bool overRead = false;
  bool closeWhenEmpty = false;

  explicit Client(Clock &clock) : clock(clock), startedAt(clock.now()) {}

  int available() {
    if (failAvailable) return -1;
    size_t arrived = 0;
    for (const Fragment &fragment : fragments) {
      if (static_cast<uint32_t>(clock.now() - startedAt) >= fragment.at) {
        arrived += fragment.size;
      }
    }
    return static_cast<int>(arrived - consumed);
  }

  int read(uint8_t *, size_t size) {
    maxRead = std::max(maxRead, size);
    if (failRead) return -1;
    if (zeroRead) return 0;
    if (overRead) return static_cast<int>(size + 1);
    const size_t count = std::min(size, static_cast<size_t>(available()));
    consumed += count;
    if (closeWhenEmpty && available() == 0) open = false;
    return static_cast<int>(count);
  }

  bool connected() const { return open; }
  void stop() { open = false; ++stops; }
  void connect() { if (!open) { open = true; ++connections; } }
};

struct Http {
  Client &client;
  int size = 0;
  std::string transferEncoding;
  bool reuse = true;
  bool serverAllowsReuse = true;
  unsigned ends = 0;

  explicit Http(Client &client) : client(client) {}
  ~Http() { client.stop(); }
  int getSize() const { return size; }
  const std::string &header(const char *) const { return transferEncoding; }
  void setReuse(bool enabled) { reuse = enabled; }
  void end() {
    ++ends;
    if (!reuse || !serverAllowsReuse) client.stop();
  }
};

bool drain(Client &client, int size) {
  return eki::http::drainResponseBody(
    client, size,
    [&client]() { return client.clock.now(); },
    [&client]() { client.clock.idle(); }
  );
}

bool finish(Http &http, bool accepted = true) {
  return eki::http::finishResponse(
    http, http.client, accepted,
    [&http]() { return http.client.clock.now(); },
    [&http]() { http.client.clock.idle(); }
  );
}

void test_empty_body_does_not_wait() {
  Clock clock;
  Client client(clock);
  TEST_ASSERT_TRUE(drain(client, 0));
  TEST_ASSERT_EQUAL(0, clock.waits);
}

void test_fragmented_body_is_fully_consumed() {
  Clock clock;
  Client client(clock);
  client.fragments = {{0, 3}, {7, 250}, {18, 5}};
  TEST_ASSERT_TRUE(drain(client, 258));
  TEST_ASSERT_EQUAL(258, client.consumed);
  TEST_ASSERT_EQUAL(18, clock.time);
  TEST_ASSERT_TRUE(client.maxRead <= 128);
}

void test_buffered_body_can_finish_after_peer_close() {
  Clock clock;
  Client client(clock);
  client.open = false;
  client.fragments = {{0, 12}};
  TEST_ASSERT_TRUE(drain(client, 12));
}

void test_unknown_and_oversized_bodies_do_not_read() {
  Clock clock;
  Client client(clock);
  client.fragments = {{0, 5000}};
  TEST_ASSERT_FALSE(drain(client, -1));
  TEST_ASSERT_FALSE(drain(client, 4097));
  TEST_ASSERT_EQUAL(0, client.consumed);
  TEST_ASSERT_EQUAL(0, clock.waits);
}

void test_maximum_body_is_supported() {
  Clock clock;
  Client client(clock);
  client.fragments = {{0, 4096}};
  TEST_ASSERT_TRUE(drain(client, 4096));
  TEST_ASSERT_EQUAL(4096, client.consumed);
}

void test_truncated_body_is_rejected() {
  Clock clock;
  Client client(clock);
  client.fragments = {{0, 3}};
  client.closeWhenEmpty = true;
  TEST_ASSERT_FALSE(drain(client, 4));
  TEST_ASSERT_EQUAL(0, clock.waits);
}

void test_partial_arrivals_cannot_extend_deadline() {
  Clock clock;
  Client client(clock);
  client.fragments = {{0, 1}, {400, 1}, {800, 1}, {1200, 1}};
  TEST_ASSERT_FALSE(drain(client, 4));
  TEST_ASSERT_EQUAL(1000, clock.time);
  TEST_ASSERT_EQUAL(3, client.consumed);
}

void test_deadline_is_exclusive() {
  Clock clock;
  Client client(clock);
  client.fragments = {{1000, 1}};
  TEST_ASSERT_FALSE(drain(client, 1));
  TEST_ASSERT_EQUAL(0, client.consumed);
}

void test_last_byte_before_deadline_is_accepted() {
  Clock clock;
  Client client(clock);
  client.fragments = {{999, 1}};
  TEST_ASSERT_TRUE(drain(client, 1));
}

void test_deadline_survives_millis_wraparound() {
  Clock clock;
  clock.time = UINT32_MAX - 10;
  Client client(clock);
  client.fragments = {{20, 1}};
  TEST_ASSERT_TRUE(drain(client, 1));
  TEST_ASSERT_EQUAL(9, clock.time);
  TEST_ASSERT_FALSE(drain(client, 1));
  TEST_ASSERT_EQUAL(1009, clock.time);
}

void test_transport_errors_and_nonprogress_are_bounded() {
  Clock clock;
  Client client(clock);
  client.fragments = {{0, 1}};
  client.failAvailable = true;
  TEST_ASSERT_FALSE(drain(client, 1));
  client.failAvailable = false;
  client.failRead = true;
  TEST_ASSERT_FALSE(drain(client, 1));
  client.failRead = false;
  client.overRead = true;
  TEST_ASSERT_FALSE(drain(client, 1));
  client.overRead = false;
  client.zeroRead = true;
  TEST_ASSERT_FALSE(drain(client, 1));
  TEST_ASSERT_EQUAL(1000, clock.waits);
}

void test_persistent_http_lifetime_preserves_connection() {
  Clock clock;
  Client client(clock);
  client.open = false;
  {
    Http http(client);
    for (int request = 0; request < 3; ++request) {
      client.connect();
      client.fragments.push_back({0, 2});
      http.size = 2;
      TEST_ASSERT_TRUE(finish(http));
      TEST_ASSERT_EQUAL(0, client.stops);
    }
    TEST_ASSERT_EQUAL(1, client.connections);
    TEST_ASSERT_EQUAL(3, http.ends);
  }
  TEST_ASSERT_EQUAL(1, client.stops);
}

void test_request_local_http_lifetime_forces_reconnect() {
  Clock clock;
  Client client(clock);
  client.open = false;
  for (int request = 0; request < 3; ++request) {
    client.connect();
    Http http(client);
    TEST_ASSERT_TRUE(finish(http));
  }
  TEST_ASSERT_EQUAL(3, client.connections);
}

void test_chunked_body_closes_without_consuming_raw_framing() {
  Clock clock;
  Client client(clock);
  client.fragments = {{0, 20}};
  Http http(client);
  http.size = 20;
  http.transferEncoding = "chunked";
  TEST_ASSERT_FALSE(finish(http));
  TEST_ASSERT_FALSE(http.reuse);
  TEST_ASSERT_FALSE(client.connected());
  TEST_ASSERT_EQUAL(0, client.consumed);
}

void test_error_response_closes_without_waiting() {
  Clock clock;
  Client client(clock);
  Http http(client);
  http.size = 20;
  TEST_ASSERT_FALSE(finish(http, false));
  TEST_ASSERT_FALSE(client.connected());
  TEST_ASSERT_EQUAL(0, clock.waits);
  TEST_ASSERT_EQUAL(1, http.ends);
}

void test_incomplete_accepted_response_closes() {
  Clock clock;
  Client client(clock);
  Http http(client);
  http.size = 1;
  TEST_ASSERT_FALSE(finish(http));
  TEST_ASSERT_FALSE(client.connected());
  TEST_ASSERT_EQUAL(1000, clock.waits);
}

void test_server_close_is_respected_and_next_request_recovers() {
  Clock clock;
  Client client(clock);
  Http http(client);
  http.serverAllowsReuse = false;
  TEST_ASSERT_FALSE(finish(http));
  TEST_ASSERT_FALSE(client.connected());
  client.connect();
  http.serverAllowsReuse = true;
  TEST_ASSERT_TRUE(finish(http));
  TEST_ASSERT_EQUAL(1, client.connections);
}
} /* namespace */

void setUp() {}
void tearDown() {}

int main() {
#ifndef EKI_STANDALONE_TEST
  UNITY_BEGIN();
#endif
  RUN_TEST(test_empty_body_does_not_wait);
  RUN_TEST(test_fragmented_body_is_fully_consumed);
  RUN_TEST(test_buffered_body_can_finish_after_peer_close);
  RUN_TEST(test_unknown_and_oversized_bodies_do_not_read);
  RUN_TEST(test_maximum_body_is_supported);
  RUN_TEST(test_truncated_body_is_rejected);
  RUN_TEST(test_partial_arrivals_cannot_extend_deadline);
  RUN_TEST(test_deadline_is_exclusive);
  RUN_TEST(test_last_byte_before_deadline_is_accepted);
  RUN_TEST(test_deadline_survives_millis_wraparound);
  RUN_TEST(test_transport_errors_and_nonprogress_are_bounded);
  RUN_TEST(test_persistent_http_lifetime_preserves_connection);
  RUN_TEST(test_request_local_http_lifetime_forces_reconnect);
  RUN_TEST(test_chunked_body_closes_without_consuming_raw_framing);
  RUN_TEST(test_error_response_closes_without_waiting);
  RUN_TEST(test_incomplete_accepted_response_closes);
  RUN_TEST(test_server_close_is_respected_and_next_request_recovers);
#ifdef EKI_STANDALONE_TEST
  std::printf("%u http session tests passed\n", testsRun);
  return 0;
#else
  return UNITY_END();
#endif
}
