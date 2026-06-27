#pragma once

#include "nmea.hpp"

#include <vector>

namespace krot {

std::vector<double> terrain_profile_m(const std::vector<RadioAltimeterSample>& samples, double baro_altitude_m);

}  // namespace krot

