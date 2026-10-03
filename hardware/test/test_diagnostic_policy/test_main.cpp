#include <unity.h>
#include "diagnostic_policy.h"

void test_age_is_rollover_safe() {
  TEST_ASSERT_EQUAL_UINT32(32, eki::diagnostics::ageMs(16, 0xFFFFFFF0u, true));
  TEST_ASSERT_EQUAL_UINT32(0, eki::diagnostics::ageMs(16, 10, false));
}

void test_retry_remaining_is_rollover_safe() {
  TEST_ASSERT_EQUAL_UINT32(
    68,
    eki::diagnostics::retryRemainingMs(16, 0xFFFFFFF0u, 100)
  );
  TEST_ASSERT_EQUAL_UINT32(0, eki::diagnostics::retryRemainingMs(1000, 100, 500));
}

int main(int, char **) {
  UNITY_BEGIN();
  RUN_TEST(test_age_is_rollover_safe);
  RUN_TEST(test_retry_remaining_is_rollover_safe);
  return UNITY_END();
}
