#include "height_map.hpp"
#include "matcher.hpp"
#include "nmea.hpp"
#include "profile.hpp"
#include "scoring.hpp"

#include <cassert>
#include <cmath>
#include <iostream>
#include <vector>

namespace {

double angle_error(double a, double b) {
  return std::abs(std::fmod(a - b + 540.0, 360.0) - 180.0);
}

void test_nmea_parser() {
  const auto sample = krot::parse_gga_sentence("$GPGGA,123519.111,,,,,,,,545.4,M,46.9,M,,*47");
  assert(sample.has_value());
  assert(std::abs(sample->radio_altitude_m - 545.4) < 0.0001);
  assert(sample->checksum_status == krot::ChecksumStatus::Invalid);
  assert(krot::checksum_hex(krot::nmea_checksum("GPGGA,123519.111,,,,,,,,545.4,M,46.9,M,,")) == "7F");
}

void test_profile_formula() {
  std::vector<krot::RadioAltimeterSample> samples = {
      {12.5, 545.4, "", krot::ChecksumStatus::Ok},
  };
  const std::vector<double> profile = krot::terrain_profile_m(samples, 1500.0);
  assert(profile.size() == 1);
  assert(std::abs(profile[0] - 954.6) < 0.0001);
}

void test_scoring() {
  const std::vector<double> profile = {300.0, 320.0, 360.0, 330.0, 310.0};
  const auto identical = krot::score_profiles(profile, profile);
  assert(identical.has_value());
  assert(identical->match_score > 0.999);
  assert(identical->profile_error_m < 0.001);

  const std::vector<double> different = {310.0, 330.0, 300.0, 360.0, 320.0};
  const auto changed = krot::score_profiles(profile, different);
  assert(changed.has_value());
  assert(changed->match_score < 0.25);
  assert(changed->profile_error_m > 25.0);
}

void test_control_log() {
  const krot::HeightMap map = krot::HeightMap::load_from_file("data/dem-sample.json");
  const krot::NmeaParseReport report = krot::read_nmea_file("data/control-radio-altimeter.nmea");
  krot::SearchConfig config;
  const krot::MatchResult result = krot::match_samples(report.samples, map, config);

  assert(result.status != krot::NavigationStatus::NoFix);
  assert(angle_error(result.azimuth_deg, 73.0) <= 2.0);
  assert(std::abs(result.speed_mps - 44.0) <= 1.0);
  assert(result.confidence > 70.0);
  assert(result.latitude_deg.has_value());
  assert(result.longitude_deg.has_value());
}

void test_flat_relief() {
  const krot::HeightMap map = krot::HeightMap::flat_for_tests(320.0);
  std::vector<krot::RadioAltimeterSample> samples;
  for (int index = 0; index < 64; ++index) {
    samples.push_back({static_cast<double>(index), 1180.0, "", krot::ChecksumStatus::Ok});
  }

  krot::SearchConfig config;
  config.speed_min_mps = 35.0;
  config.speed_max_mps = 36.0;
  const krot::MatchResult result = krot::match_samples(samples, map, config);
  assert(result.status == krot::NavigationStatus::LowRelief || result.status == krot::NavigationStatus::NoFix);
  assert(result.confidence < 50.0);
}

}  // namespace

int main() {
  test_nmea_parser();
  test_profile_formula();
  test_scoring();
  test_control_log();
  test_flat_relief();

  std::cout << "C++ core tests passed\n";
  return 0;
}

