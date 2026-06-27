#pragma once

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace krot {

enum class ChecksumStatus {
  Ok,
  Missing,
  Invalid,
};

struct RadioAltimeterSample {
  double time_s = 0.0;
  double radio_altitude_m = 0.0;
  std::string sentence;
  ChecksumStatus checksum_status = ChecksumStatus::Missing;
};

struct NmeaParseReport {
  std::vector<RadioAltimeterSample> samples;
  std::size_t skipped_lines = 0;
  std::size_t checksum_ok = 0;
  std::size_t checksum_missing = 0;
  std::size_t checksum_invalid = 0;
};

std::uint8_t nmea_checksum(const std::string& payload);
std::string checksum_hex(std::uint8_t value);
std::optional<RadioAltimeterSample> parse_gga_sentence(const std::string& sentence);
NmeaParseReport parse_nmea_stream(const std::string& text);
NmeaParseReport read_nmea_file(const std::string& path);

}  // namespace krot

