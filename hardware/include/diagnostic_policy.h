#pragma once

#include <cstdint>

namespace eki {
namespace diagnostics {

inline uint32_t ageMs(uint32_t now, uint32_t since, bool seen) {
  return seen ? now - since : 0;
}

inline uint32_t retryRemainingMs(
  uint32_t now,
  uint32_t startedAt,
  uint32_t delayMs
) {
  const uint32_t age = now - startedAt;
  return delayMs > age ? delayMs - age : 0;
}

} // namespace diagnostics
} // namespace eki
