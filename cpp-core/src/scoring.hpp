#pragma once

#include <optional>
#include <vector>

namespace krot {

struct ProfileScore {
  double match_score = 0.0;
  double profile_error_m = 0.0;
};

std::optional<ProfileScore> score_profiles(const std::vector<double>& measured, const std::vector<double>& reference);
double relief_m(const std::vector<double>& profile);
double standard_deviation_m(const std::vector<double>& profile);

}  // namespace krot

