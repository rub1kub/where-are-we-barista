#pragma once

#include <optional>
#include <string>
#include <utility>
#include <vector>

namespace krot {

struct HeightMap {
  int width = 0;
  int height = 0;
  double min_lat = 0.0;
  double max_lat = 0.0;
  double min_lon = 0.0;
  double max_lon = 0.0;
  double origin_lat = 60.3446;
  double origin_lon = 102.2797;
  double cell_size_m = 30.0;
  std::vector<double> heights_m;

  static HeightMap load_from_file(const std::string& path);
  static HeightMap flat_for_tests(double height_m);

  void validate() const;
  std::pair<double, double> local_to_lat_lon(double x_m, double y_m) const;
  std::optional<double> sample_local_m(double x_m, double y_m) const;
  std::optional<double> sample_lat_lon(double lat, double lon) const;
};

}  // namespace krot

