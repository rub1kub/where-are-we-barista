#include "nmea.hpp"

#include <algorithm>
#include <cctype>
#include <fstream>
#include <iomanip>
#include <sstream>
#include <stdexcept>

namespace krot {
namespace {

std::string trim(const std::string& value) {
  auto begin = value.begin();
  while (begin != value.end() && std::isspace(static_cast<unsigned char>(*begin))) {
    ++begin;
  }
  auto end = value.end();
  while (end != begin && std::isspace(static_cast<unsigned char>(*(end - 1)))) {
    --end;
  }
  return std::string(begin, end);
}

std::vector<std::string> split(const std::string& value, char delimiter) {
  std::vector<std::string> fields;
  std::stringstream stream(value);
  std::string item;
  while (std::getline(stream, item, delimiter)) {
    fields.push_back(item);
  }
  if (!value.empty() && value.back() == delimiter) {
    fields.emplace_back();
  }
  return fields;
}

double parse_nmea_time(const std::string& value) {
  if (value.size() < 6) {
    return 0.0;
  }

  try {
    const double hours = std::stod(value.substr(0, 2));
    const double minutes = std::stod(value.substr(2, 2));
    const double seconds = std::stod(value.substr(4));
    return hours * 3600.0 + minutes * 60.0 + seconds;
  } catch (...) {
    return 0.0;
  }
}

std::string uppercase(std::string value) {
  std::transform(value.begin(), value.end(), value.begin(), [](unsigned char c) {
    return static_cast<char>(std::toupper(c));
  });
  return value;
}

}  // namespace

std::uint8_t nmea_checksum(const std::string& payload) {
  std::uint8_t checksum = 0;
  for (const unsigned char item : payload) {
    checksum ^= item;
  }
  return checksum;
}

std::string checksum_hex(std::uint8_t value) {
  std::ostringstream stream;
  stream << std::uppercase << std::hex << std::setw(2) << std::setfill('0') << static_cast<int>(value);
  return stream.str();
}

std::optional<RadioAltimeterSample> parse_gga_sentence(const std::string& sentence) {
  const std::string trimmed = trim(sentence);
  if (trimmed.empty()) {
    return std::nullopt;
  }

  std::string body = trimmed;
  if (!body.empty() && body.front() == '$') {
    body.erase(body.begin());
  }

  const std::size_t checksum_separator = body.find('*');
  const std::string payload = checksum_separator == std::string::npos
      ? body
      : body.substr(0, checksum_separator);
  const std::optional<std::string> provided_checksum = checksum_separator == std::string::npos
      ? std::nullopt
      : std::optional<std::string>(uppercase(trim(body.substr(checksum_separator + 1))));

  const std::vector<std::string> fields = split(payload, ',');
  if (fields.empty() || (fields[0] != "GPGGA" && fields[0] != "GNGGA")) {
    return std::nullopt;
  }
  if (fields.size() <= 9) {
    return std::nullopt;
  }

  double radio_altitude_m = 0.0;
  try {
    radio_altitude_m = std::stod(fields[9]);
  } catch (...) {
    return std::nullopt;
  }

  const std::string expected_checksum = checksum_hex(nmea_checksum(payload));
  ChecksumStatus status = ChecksumStatus::Missing;
  if (provided_checksum.has_value()) {
    status = *provided_checksum == expected_checksum ? ChecksumStatus::Ok : ChecksumStatus::Invalid;
  }

  return RadioAltimeterSample{
      parse_nmea_time(fields.size() > 1 ? fields[1] : "0"),
      radio_altitude_m,
      trimmed,
      status,
  };
}

NmeaParseReport parse_nmea_stream(const std::string& text) {
  NmeaParseReport report;
  std::stringstream stream(text);
  std::string line;

  while (std::getline(stream, line)) {
    if (trim(line).empty()) {
      continue;
    }

    const std::optional<RadioAltimeterSample> sample = parse_gga_sentence(line);
    if (!sample.has_value()) {
      report.skipped_lines += 1;
      continue;
    }

    switch (sample->checksum_status) {
      case ChecksumStatus::Ok:
        report.checksum_ok += 1;
        break;
      case ChecksumStatus::Missing:
        report.checksum_missing += 1;
        break;
      case ChecksumStatus::Invalid:
        report.checksum_invalid += 1;
        break;
    }
    report.samples.push_back(*sample);
  }

  return report;
}

NmeaParseReport read_nmea_file(const std::string& path) {
  std::ifstream file(path);
  if (!file) {
    throw std::runtime_error("не удалось открыть журнал: строка радиовысотомера недоступна");
  }

  std::stringstream buffer;
  buffer << file.rdbuf();
  return parse_nmea_stream(buffer.str());
}

}  // namespace krot

