#include "matcher.hpp"

#include "profile.hpp"
#include "scoring.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <limits>

namespace krot {
namespace {

constexpr double kPi = 3.14159265358979323846;

struct Candidate {
  double azimuth_deg = 0.0;
  double speed_mps = 0.0;
  double shift_m = 0.0;
  double match_score = -1.0;
  double profile_error_m = std::numeric_limits<double>::infinity();
};

bool is_better(const Candidate& candidate, const std::optional<Candidate>& current) {
  if (!current.has_value()) {
    return true;
  }
  return candidate.match_score > current->match_score ||
      (std::abs(candidate.match_score - current->match_score) < std::numeric_limits<double>::epsilon() &&
       candidate.profile_error_m < current->profile_error_m);
}

std::vector<double> normalize_sample_times(const std::vector<RadioAltimeterSample>& samples, double fallback_sample_rate_hz) {
  if (samples.empty()) {
    return {};
  }

  std::vector<double> absolute;
  absolute.reserve(samples.size());
  double day_offset = 0.0;
  double previous = samples.front().time_s;
  for (std::size_t index = 0; index < samples.size(); ++index) {
    if (index > 0 && samples[index].time_s + day_offset < previous - 1.0) {
      day_offset += 86400.0;
    }
    const double value = samples[index].time_s + day_offset;
    absolute.push_back(value);
    previous = value;
  }

  std::vector<double> times;
  times.reserve(samples.size());
  const double first = absolute.front();
  for (const double value : absolute) {
    times.push_back(value - first);
  }

  if (times.back() <= 0.0001) {
    times.clear();
    for (std::size_t index = 0; index < samples.size(); ++index) {
      times.push_back(static_cast<double>(index) / fallback_sample_rate_hz);
    }
  }

  return times;
}

std::vector<std::size_t> downsample_indexes(std::size_t length, std::size_t target_length) {
  const std::size_t count = std::min(length, target_length);
  if (count <= 1) {
    return {0};
  }

  std::vector<std::size_t> indexes;
  indexes.reserve(count);
  for (std::size_t index = 0; index < count; ++index) {
    indexes.push_back(static_cast<std::size_t>(
        std::llround((static_cast<double>(index) * static_cast<double>(length - 1)) / static_cast<double>(count - 1))));
  }
  return indexes;
}

std::optional<ProfileScore> score_candidate(
    const HeightMap& map,
    const std::vector<double>& measured,
    const std::vector<double>& times,
    double azimuth_deg,
    double speed_mps,
    double shift_m) {
  std::vector<double> reference;
  reference.reserve(times.size());
  const double azimuth_rad = azimuth_deg * kPi / 180.0;
  const double sin_azimuth = std::sin(azimuth_rad);
  const double cos_azimuth = std::cos(azimuth_rad);

  for (const double time_s : times) {
    const double distance_m = shift_m + speed_mps * time_s;
    const std::optional<double> height = map.sample_local_m(sin_azimuth * distance_m, cos_azimuth * distance_m);
    if (!height.has_value()) {
      return std::nullopt;
    }
    reference.push_back(*height);
  }

  return score_profiles(measured, reference);
}

double confidence_score(double correlation, double relief, double ambiguity, double profile_error_m) {
  const double corr_score = std::clamp((correlation - 0.55) / 0.44, 0.0, 1.0);
  const double relief_score = std::clamp((relief - 35.0) / 210.0, 0.0, 1.0);
  const double peak_score = std::clamp(ambiguity / 0.02, 0.0, 1.0);
  const double error_score = std::clamp(1.0 - profile_error_m / 65.0, 0.0, 1.0);
  return (0.46 * corr_score + 0.22 * relief_score + 0.12 * peak_score + 0.20 * error_score) * 100.0;
}

NavigationStatus classify_status(
    double confidence,
    double relief,
    double terrain_std,
    double ambiguity,
    double correlation,
    double profile_error_m) {
  if (!std::isfinite(correlation) || !std::isfinite(profile_error_m)) {
    return NavigationStatus::NoFix;
  }
  if (relief < 35.0 || terrain_std < 9.0) {
    return NavigationStatus::LowRelief;
  }
  if (confidence < 18.0 || correlation < 0.42 || profile_error_m > 180.0) {
    return NavigationStatus::NoFix;
  }
  if (ambiguity < 0.008) {
    return NavigationStatus::Ambiguous;
  }
  if (confidence < 72.0 || correlation < 0.78 || profile_error_m > 80.0) {
    return NavigationStatus::Degraded;
  }
  return NavigationStatus::Valid;
}

MatchResult no_fix(const std::chrono::steady_clock::time_point& started) {
  const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::steady_clock::now() - started);
  MatchResult result;
  result.status = NavigationStatus::NoFix;
  result.profile_error_m = std::numeric_limits<double>::infinity();
  result.compute_ms = elapsed.count();
  return result;
}

}  // namespace

std::string status_code(NavigationStatus status) {
  switch (status) {
    case NavigationStatus::Valid:
      return "VALID";
    case NavigationStatus::Degraded:
      return "DEGRADED";
    case NavigationStatus::Ambiguous:
      return "AMBIGUOUS";
    case NavigationStatus::LowRelief:
      return "LOW_RELIEF";
    case NavigationStatus::NoFix:
      return "NO_FIX";
  }
  return "NO_FIX";
}

std::string status_label_ru(NavigationStatus status) {
  switch (status) {
    case NavigationStatus::Valid:
      return "МЕСТО НАЙДЕНО";
    case NavigationStatus::Degraded:
      return "ПРИВЯЗКА НЕТОЧНАЯ";
    case NavigationStatus::Ambiguous:
      return "НЕСКОЛЬКО ВАРИАНТОВ";
    case NavigationStatus::LowRelief:
      return "СЛАБЫЙ РЕЛЬЕФ";
    case NavigationStatus::NoFix:
      return "МЕСТО НЕ НАЙДЕНО";
  }
  return "МЕСТО НЕ НАЙДЕНО";
}

MatchResult match_samples(const std::vector<RadioAltimeterSample>& samples, const HeightMap& map, const SearchConfig& config) {
  return match_profile(terrain_profile_m(samples, config.baro_altitude_m), normalize_sample_times(samples, config.fallback_sample_rate_hz), map, config);
}

MatchResult match_profile(
    const std::vector<double>& measured_profile,
    const std::vector<double>& sample_times_s,
    const HeightMap& map,
    const SearchConfig& config) {
  const auto started = std::chrono::steady_clock::now();
  if (measured_profile.size() < 12 || measured_profile.size() != sample_times_s.size()) {
    return no_fix(started);
  }

  const std::vector<std::size_t> indexes = downsample_indexes(measured_profile.size(), config.max_profile_samples);
  std::vector<double> measured;
  std::vector<double> times;
  measured.reserve(indexes.size());
  times.reserve(indexes.size());
  for (const std::size_t index : indexes) {
    measured.push_back(measured_profile[index]);
    times.push_back(sample_times_s[index]);
  }

  const double measured_relief = relief_m(measured);
  const double measured_std = standard_deviation_m(measured);
  std::optional<Candidate> best;
  std::optional<double> second_score;

  for (int azimuth = 0; azimuth < 360; ++azimuth) {
    for (double speed = config.speed_min_mps; speed <= config.speed_max_mps + 0.0001; speed += config.speed_step_mps) {
      std::optional<Candidate> best_for_cell;

      for (const double shift : config.shift_candidates_m) {
        const std::optional<ProfileScore> score = score_candidate(map, measured, times, static_cast<double>(azimuth), speed, shift);
        if (!score.has_value()) {
          continue;
        }
        Candidate candidate{
            static_cast<double>(azimuth),
            speed,
            shift,
            score->match_score,
            score->profile_error_m,
        };
        if (is_better(candidate, best_for_cell)) {
          best_for_cell = candidate;
        }
      }

      if (!best_for_cell.has_value()) {
        continue;
      }

      if (is_better(*best_for_cell, best)) {
        if (best.has_value()) {
          second_score = best->match_score;
        }
        best = best_for_cell;
      } else if (!second_score.has_value() || best_for_cell->match_score > *second_score) {
        second_score = best_for_cell->match_score;
      }
    }
  }

  if (!best.has_value()) {
    return no_fix(started);
  }

  const double ambiguity = std::max(0.0, best->match_score - second_score.value_or(best->match_score - 1.0));
  const double confidence = confidence_score(best->match_score, measured_relief, ambiguity, best->profile_error_m);
  const NavigationStatus status = classify_status(
      confidence,
      measured_relief,
      measured_std,
      ambiguity,
      best->match_score,
      best->profile_error_m);
  const double final_time_s = sample_times_s.back();
  const double final_distance_m = best->shift_m + best->speed_mps * final_time_s;
  const double azimuth_rad = best->azimuth_deg * kPi / 180.0;
  const double x_m = std::sin(azimuth_rad) * final_distance_m;
  const double y_m = std::cos(azimuth_rad) * final_distance_m;
  const auto [lat, lon] = map.local_to_lat_lon(x_m, y_m);
  const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::steady_clock::now() - started);

  return MatchResult{
      status,
      x_m,
      y_m,
      lat,
      lon,
      best->speed_mps,
      best->azimuth_deg,
      best->match_score,
      best->profile_error_m,
      confidence,
      elapsed.count(),
  };
}

}  // namespace krot

