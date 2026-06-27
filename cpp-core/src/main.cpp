#include "height_map.hpp"
#include "matcher.hpp"
#include "nmea.hpp"

#include <exception>
#include <cmath>
#include <cstdlib>
#include <iomanip>
#include <iostream>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>

namespace {

struct CliArgs {
  std::string dem_path = "data/dem-sample.json";
  std::string nmea_path = "data/control-radio-altimeter.nmea";
  double baro_altitude_m = 1500.0;
  double speed_min_mps = 35.0;
  double speed_max_mps = 65.0;
  double speed_step_mps = 1.0;
  bool json = false;
};

void print_help() {
  std::cout
      << "Использование:\n"
      << "  ./krot_cpp --dem data/dem-sample.json --nmea data/control-radio-altimeter.nmea --baro 1500\n\n"
      << "Параметры:\n"
      << "  --dem <path>         карта высот JSON\n"
      << "  --nmea <path>        журнал радиовысотомера NMEA\n"
      << "  --baro <m>           высота борта над уровнем моря, по умолчанию 1500\n"
      << "  --speed-min <mps>    минимальная путевая скорость\n"
      << "  --speed-max <mps>    максимальная путевая скорость\n"
      << "  --speed-step <mps>   шаг перебора скорости\n"
      << "  --json               вывести JSON\n";
}

std::string require_value(int& index, int argc, char** argv, const std::string& name) {
  if (index + 1 >= argc) {
    throw std::runtime_error("нет значения для " + name);
  }
  ++index;
  const std::string value = argv[index];
  if (value.rfind("--", 0) == 0) {
    throw std::runtime_error("нет значения для " + name);
  }
  return value;
}

CliArgs parse_args(int argc, char** argv) {
  CliArgs args;

  for (int index = 1; index < argc; ++index) {
    const std::string arg = argv[index];
    if (arg == "--help" || arg == "-h") {
      print_help();
      std::exit(0);
    } else if (arg == "--dem") {
      args.dem_path = require_value(index, argc, argv, arg);
    } else if (arg == "--nmea") {
      args.nmea_path = require_value(index, argc, argv, arg);
    } else if (arg == "--baro") {
      args.baro_altitude_m = std::stod(require_value(index, argc, argv, arg));
    } else if (arg == "--speed-min") {
      args.speed_min_mps = std::stod(require_value(index, argc, argv, arg));
    } else if (arg == "--speed-max") {
      args.speed_max_mps = std::stod(require_value(index, argc, argv, arg));
    } else if (arg == "--speed-step") {
      args.speed_step_mps = std::stod(require_value(index, argc, argv, arg));
    } else if (arg == "--json") {
      args.json = true;
    } else {
      throw std::runtime_error("неизвестный аргумент: " + arg);
    }
  }

  return args;
}

void print_json_number_or_null(const std::optional<double>& value) {
  if (value.has_value() && std::isfinite(*value)) {
    std::cout << std::fixed << std::setprecision(6) << *value;
  } else {
    std::cout << "null";
  }
}

void print_json_finite_or_null(double value, int precision) {
  if (std::isfinite(value)) {
    std::cout << std::fixed << std::setprecision(precision) << value;
  } else {
    std::cout << "null";
  }
}

void print_json(const krot::MatchResult& result) {
  std::cout << "{\n";
  std::cout << "  \"status\": \"" << krot::status_code(result.status) << "\",\n";
  std::cout << "  \"x_m\": ";
  print_json_finite_or_null(result.x_m, 3);
  std::cout << ",\n";
  std::cout << "  \"y_m\": ";
  print_json_finite_or_null(result.y_m, 3);
  std::cout << ",\n";
  std::cout << "  \"latitude_deg\": ";
  print_json_number_or_null(result.latitude_deg);
  std::cout << ",\n";
  std::cout << "  \"longitude_deg\": ";
  print_json_number_or_null(result.longitude_deg);
  std::cout << ",\n";
  std::cout << "  \"speed_mps\": ";
  print_json_finite_or_null(result.speed_mps, 3);
  std::cout << ",\n";
  std::cout << "  \"azimuth_deg\": ";
  print_json_finite_or_null(result.azimuth_deg, 3);
  std::cout << ",\n";
  std::cout << "  \"match_score\": ";
  print_json_finite_or_null(result.match_score, 6);
  std::cout << ",\n";
  std::cout << "  \"profile_error_m\": ";
  print_json_finite_or_null(result.profile_error_m, 3);
  std::cout << ",\n";
  std::cout << "  \"confidence\": ";
  print_json_finite_or_null(result.confidence, 3);
  std::cout << ",\n";
  std::cout << "  \"compute_ms\": " << result.compute_ms << "\n";
  std::cout << "}\n";
}

void print_human(const krot::MatchResult& result) {
  std::cout << "КРОТ / C++ ядро расчёта\n\n";
  std::cout << "Статус: " << krot::status_label_ru(result.status) << "\n";
  std::cout << "X: " << std::fixed << std::setprecision(0) << result.x_m << " м\n";
  std::cout << "Y: " << std::fixed << std::setprecision(0) << result.y_m << " м\n";
  std::cout << "Широта: ";
  if (result.latitude_deg.has_value()) {
    std::cout << std::fixed << std::setprecision(6) << *result.latitude_deg << "\n";
  } else {
    std::cout << "н/д\n";
  }
  std::cout << "Долгота: ";
  if (result.longitude_deg.has_value()) {
    std::cout << std::fixed << std::setprecision(6) << *result.longitude_deg << "\n";
  } else {
    std::cout << "н/д\n";
  }
  std::cout << "Скорость: " << std::fixed << std::setprecision(1) << result.speed_mps << " м/с\n";
  std::cout << "Направление: " << std::fixed << std::setprecision(0) << result.azimuth_deg << "°\n";
  std::cout << "Совпадение: " << std::fixed << std::setprecision(4) << result.match_score << "\n";
  std::cout << "Ошибка профиля: " << std::fixed << std::setprecision(0) << result.profile_error_m << " м\n";
  std::cout << "Доверие: " << std::fixed << std::setprecision(0) << result.confidence << "%\n";
  std::cout << "Время расчёта: " << result.compute_ms << " мс\n";
}

}  // namespace

int main(int argc, char** argv) {
  try {
    const CliArgs args = parse_args(argc, argv);
    const krot::HeightMap map = krot::HeightMap::load_from_file(args.dem_path);
    const krot::NmeaParseReport report = krot::read_nmea_file(args.nmea_path);

    if (report.samples.empty()) {
      throw std::runtime_error("в журнале нет пригодных строк радиовысотомера с расстоянием до земли");
    }

    krot::SearchConfig config;
    config.baro_altitude_m = args.baro_altitude_m;
    config.speed_min_mps = args.speed_min_mps;
    config.speed_max_mps = args.speed_max_mps;
    config.speed_step_mps = args.speed_step_mps;

    const krot::MatchResult result = krot::match_samples(report.samples, map, config);
    if (args.json) {
      print_json(result);
    } else {
      print_human(result);
    }
  } catch (const std::exception& error) {
    std::cerr << "Ошибка: " << error.what() << "\n";
    return 1;
  }

  return 0;
}
