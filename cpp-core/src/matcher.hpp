#pragma once

#include "height_map.hpp"
#include "nmea.hpp"

#include <optional>
#include <string>
#include <vector>

namespace krot {

enum class NavigationStatus {
  Valid,
  Degraded,
  Ambiguous,
  LowRelief,
  NoFix,
};

struct SearchConfig {
  double baro_altitude_m = 1500.0;
  double fallback_sample_rate_hz = 2.0;
  double speed_min_mps = 35.0;
  double speed_max_mps = 65.0;
  double speed_step_mps = 1.0;
  std::vector<double> shift_candidates_m = {-3000.0, -1500.0, 0.0, 1500.0, 3000.0};
  std::size_t max_profile_samples = 260;
};

struct MatchResult {
  NavigationStatus status = NavigationStatus::NoFix;
  double x_m = 0.0;
  double y_m = 0.0;
  std::optional<double> latitude_deg;
  std::optional<double> longitude_deg;
  double speed_mps = 0.0;
  double azimuth_deg = 0.0;
  double match_score = 0.0;
  double profile_error_m = 0.0;
  double confidence = 0.0;
  long long compute_ms = 0;
};

std::string status_code(NavigationStatus status);
std::string status_label_ru(NavigationStatus status);
MatchResult match_samples(const std::vector<RadioAltimeterSample>& samples, const HeightMap& map, const SearchConfig& config);
MatchResult match_profile(
    const std::vector<double>& measured_profile,
    const std::vector<double>& sample_times_s,
    const HeightMap& map,
    const SearchConfig& config);

}  // namespace krot

