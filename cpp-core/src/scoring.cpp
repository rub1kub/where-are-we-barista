#include "scoring.hpp"

#include <algorithm>
#include <cmath>
#include <limits>

namespace krot {

std::optional<ProfileScore> score_profiles(const std::vector<double>& measured, const std::vector<double>& reference) {
  if (measured.empty() || measured.size() != reference.size()) {
    return std::nullopt;
  }

  const double count = static_cast<double>(measured.size());
  double measured_sum = 0.0;
  double reference_sum = 0.0;
  for (std::size_t index = 0; index < measured.size(); ++index) {
    measured_sum += measured[index];
    reference_sum += reference[index];
  }

  const double measured_mean = measured_sum / count;
  const double reference_mean = reference_sum / count;
  double measured_variance = 0.0;
  double reference_variance = 0.0;
  double covariance = 0.0;
  double error_sq = 0.0;

  for (std::size_t index = 0; index < measured.size(); ++index) {
    const double measured_delta = measured[index] - measured_mean;
    const double reference_delta = reference[index] - reference_mean;
    measured_variance += measured_delta * measured_delta;
    reference_variance += reference_delta * reference_delta;
    covariance += measured_delta * reference_delta;
    const double error = measured[index] - reference[index];
    error_sq += error * error;
  }

  const double denominator = std::sqrt(std::max(0.0, measured_variance * reference_variance));

  // Показатель совпадения показывает, насколько линия измерений похожа на линию с карты.
  return ProfileScore{
      denominator > 0.0 ? covariance / denominator : 0.0,
      std::sqrt(error_sq / count),
  };
}

double relief_m(const std::vector<double>& profile) {
  if (profile.empty()) {
    return 0.0;
  }

  double min_value = std::numeric_limits<double>::infinity();
  double max_value = -std::numeric_limits<double>::infinity();
  for (const double value : profile) {
    min_value = std::min(min_value, value);
    max_value = std::max(max_value, value);
  }
  return max_value - min_value;
}

double standard_deviation_m(const std::vector<double>& profile) {
  if (profile.empty()) {
    return 0.0;
  }

  double sum = 0.0;
  for (const double value : profile) {
    sum += value;
  }
  const double mean = sum / static_cast<double>(profile.size());

  double variance = 0.0;
  for (const double value : profile) {
    variance += std::pow(value - mean, 2.0);
  }
  return std::sqrt(variance / static_cast<double>(profile.size()));
}

}  // namespace krot
