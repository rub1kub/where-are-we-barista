#include "height_map.hpp"

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <fstream>
#include <sstream>
#include <stdexcept>

namespace krot {
namespace {

constexpr double kDefaultOriginLat = 60.3446;
constexpr double kDefaultOriginLon = 102.2797;
constexpr double kMetersPerDegreeLat = 111320.0;
constexpr double kPi = 3.14159265358979323846;

std::string read_text_file(const std::string& path) {
  std::ifstream file(path);
  if (!file) {
    throw std::runtime_error("не удалось открыть карту высот");
  }
  std::stringstream buffer;
  buffer << file.rdbuf();
  return buffer.str();
}

std::optional<double> read_number_field(const std::string& source, const std::string& key) {
  const std::string marker = "\"" + key + "\"";
  const std::size_t key_position = source.find(marker);
  if (key_position == std::string::npos) {
    return std::nullopt;
  }

  const std::size_t colon_position = source.find(':', key_position + marker.size());
  if (colon_position == std::string::npos) {
    return std::nullopt;
  }

  const char* start = source.c_str() + colon_position + 1;
  char* end = nullptr;
  const double value = std::strtod(start, &end);
  if (start == end) {
    return std::nullopt;
  }
  return value;
}

double require_number_field(const std::string& source, const std::string& key) {
  const std::optional<double> value = read_number_field(source, key);
  if (!value.has_value()) {
    throw std::runtime_error("в карте высот нет поля " + key);
  }
  return *value;
}

std::vector<double> read_heights(const std::string& source) {
  const std::string marker = "\"heights_m\"";
  const std::size_t key_position = source.find(marker);
  if (key_position == std::string::npos) {
    throw std::runtime_error("в карте высот нет массива heights_m");
  }

  const std::size_t array_begin = source.find('[', key_position + marker.size());
  const std::size_t array_end = source.find(']', array_begin);
  if (array_begin == std::string::npos || array_end == std::string::npos) {
    throw std::runtime_error("массив heights_m повреждён");
  }

  std::vector<double> values;
  const char* current = source.c_str() + array_begin + 1;
  const char* end = source.c_str() + array_end;
  while (current < end) {
    char* next = nullptr;
    const double value = std::strtod(current, &next);
    if (next == current) {
      ++current;
      continue;
    }
    values.push_back(value);
    current = next;
  }
  return values;
}

int nearest_index(double value, int max_index) {
  return static_cast<int>(std::clamp(std::llround(value), 0LL, static_cast<long long>(max_index)));
}

}  // namespace

HeightMap HeightMap::load_from_file(const std::string& path) {
  const std::string source = read_text_file(path);
  HeightMap map;
  map.width = static_cast<int>(require_number_field(source, "width"));
  map.height = static_cast<int>(require_number_field(source, "height"));
  map.min_lat = require_number_field(source, "min_lat");
  map.max_lat = require_number_field(source, "max_lat");
  map.min_lon = require_number_field(source, "min_lon");
  map.max_lon = require_number_field(source, "max_lon");
  map.origin_lat = read_number_field(source, "origin_lat").value_or(kDefaultOriginLat);
  map.origin_lon = read_number_field(source, "origin_lon").value_or(kDefaultOriginLon);
  map.cell_size_m = read_number_field(source, "cell_size_m").value_or(30.0);
  map.heights_m = read_heights(source);
  map.validate();
  return map;
}

HeightMap HeightMap::flat_for_tests(double height_m) {
  HeightMap map;
  map.width = 8;
  map.height = 8;
  map.min_lat = 60.25;
  map.max_lat = 60.95;
  map.min_lon = 102.15;
  map.max_lon = 105.65;
  map.origin_lat = kDefaultOriginLat;
  map.origin_lon = kDefaultOriginLon;
  map.cell_size_m = 30.0;
  map.heights_m.assign(static_cast<std::size_t>(map.width * map.height), height_m);
  return map;
}

void HeightMap::validate() const {
  if (width <= 0 || height <= 0) {
    throw std::runtime_error("размер карты высот должен быть положительным");
  }
  if (heights_m.size() != static_cast<std::size_t>(width * height)) {
    throw std::runtime_error("размер массива heights_m не совпадает с width * height");
  }
}

std::pair<double, double> HeightMap::local_to_lat_lon(double x_m, double y_m) const {
  const double lat = origin_lat + y_m / kMetersPerDegreeLat;
  const double meters_per_degree_lon = kMetersPerDegreeLat * std::cos(origin_lat * kPi / 180.0);
  const double lon = origin_lon + x_m / meters_per_degree_lon;
  return {lat, lon};
}

std::optional<double> HeightMap::sample_local_m(double x_m, double y_m) const {
  const auto [lat, lon] = local_to_lat_lon(x_m, y_m);
  return sample_lat_lon(lat, lon);
}

std::optional<double> HeightMap::sample_lat_lon(double lat, double lon) const {
  if (lat < min_lat || lat > max_lat || lon < min_lon || lon > max_lon) {
    return std::nullopt;
  }

  const double px = ((lon - min_lon) / (max_lon - min_lon)) * static_cast<double>(width - 1);
  const double py = ((max_lat - lat) / (max_lat - min_lat)) * static_cast<double>(height - 1);
  const int x = nearest_index(px, width - 1);
  const int y = nearest_index(py, height - 1);
  return heights_m[static_cast<std::size_t>(y * width + x)];
}

}  // namespace krot
