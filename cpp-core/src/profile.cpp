#include "profile.hpp"

namespace krot {

std::vector<double> terrain_profile_m(const std::vector<RadioAltimeterSample>& samples, double baro_altitude_m) {
  std::vector<double> profile;
  profile.reserve(samples.size());

  for (const RadioAltimeterSample& sample : samples) {
    profile.push_back(baro_altitude_m - sample.radio_altitude_m);
  }

  return profile;
}

}  // namespace krot

