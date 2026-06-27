use krot_rust_core::dem::DemGrid;
use krot_rust_core::matcher::{match_samples, status_label_ru, SearchConfig};
use krot_rust_core::nmea::parse_nmea_stream;
use std::env;
use std::error::Error;
use std::fs;
use std::process;

#[derive(Debug)]
struct CliArgs {
    dem_path: String,
    nmea_path: String,
    baro_altitude_m: f64,
    speed_min_mps: f64,
    speed_max_mps: f64,
    speed_step_mps: f64,
    json: bool,
}

impl Default for CliArgs {
    fn default() -> Self {
        Self {
            dem_path: "data/dem-sample.json".to_string(),
            nmea_path: "data/control-radio-altimeter.nmea".to_string(),
            baro_altitude_m: 1500.0,
            speed_min_mps: 35.0,
            speed_max_mps: 65.0,
            speed_step_mps: 1.0,
            json: false,
        }
    }
}

fn main() {
    if let Err(error) = run() {
        eprintln!("Ошибка: {error}");
        process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn Error>> {
    let args = parse_args(env::args().skip(1))?;
    let dem = DemGrid::load(&args.dem_path)?;
    let text = fs::read_to_string(&args.nmea_path)?;
    let report = parse_nmea_stream(&text);

    if report.samples.is_empty() {
        return Err("в журнале нет пригодных GGA-сообщений радиовысотомера".into());
    }

    let config = SearchConfig {
        baro_altitude_m: args.baro_altitude_m,
        speed_min_mps: args.speed_min_mps,
        speed_max_mps: args.speed_max_mps,
        speed_step_mps: args.speed_step_mps,
        ..SearchConfig::default()
    };
    let result = match_samples(&report.samples, &dem, &config);

    if args.json {
        println!("{}", serde_json::to_string_pretty(&result)?);
        return Ok(());
    }

    println!("КРОТ / Rust-ядро");
    println!("Статус: {}", status_label_ru(result.status));
    println!("X: {:.0} м", result.x_m);
    println!("Y: {:.0} м", result.y_m);
    println!(
        "Широта: {}",
        result
            .latitude_deg
            .map(|value| format!("{value:.6}"))
            .unwrap_or_else(|| "н/д".to_string())
    );
    println!(
        "Долгота: {}",
        result
            .longitude_deg
            .map(|value| format!("{value:.6}"))
            .unwrap_or_else(|| "н/д".to_string())
    );
    println!("Скорость: {:.1} м/с", result.speed_mps);
    println!("Направление: {:.0}°", result.azimuth_deg);
    println!("Совпадение: {:.4}", result.match_score);
    println!("Ошибка профиля: {:.0} м", result.profile_error_m);
    println!("Доверие: {:.0}%", result.confidence);
    println!("Время расчёта: {} мс", result.compute_ms);

    Ok(())
}

fn parse_args(args: impl Iterator<Item = String>) -> Result<CliArgs, Box<dyn Error>> {
    let mut parsed = CliArgs::default();
    let mut args = args.peekable();

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--help" | "-h" => {
                print_help();
                process::exit(0);
            }
            "--dem" => parsed.dem_path = take_value(&mut args, "--dem")?,
            "--nmea" => parsed.nmea_path = take_value(&mut args, "--nmea")?,
            "--baro" => parsed.baro_altitude_m = take_value(&mut args, "--baro")?.parse()?,
            "--speed-min" => {
                parsed.speed_min_mps = take_value(&mut args, "--speed-min")?.parse()?
            }
            "--speed-max" => {
                parsed.speed_max_mps = take_value(&mut args, "--speed-max")?.parse()?
            }
            "--speed-step" => {
                parsed.speed_step_mps = take_value(&mut args, "--speed-step")?.parse()?
            }
            "--json" => parsed.json = true,
            unknown => return Err(format!("неизвестный аргумент: {unknown}").into()),
        }
    }

    Ok(parsed)
}

fn take_value(
    args: &mut impl Iterator<Item = String>,
    name: &str,
) -> Result<String, Box<dyn Error>> {
    args.next()
        .filter(|value| !value.starts_with("--"))
        .ok_or_else(|| format!("нет значения для {name}").into())
}

fn print_help() {
    println!(
        "Использование:
  cargo run --release -- --dem data/dem-sample.json --nmea data/control-radio-altimeter.nmea --baro 1500

Параметры:
  --dem <path>            карта высот JSON, по умолчанию data/dem-sample.json
  --nmea <path>           журнал радиовысотомера, по умолчанию data/control-radio-altimeter.nmea
  --baro <m>              высота борта над уровнем моря, по умолчанию 1500
  --speed-min <mps>       минимальная путевая скорость, по умолчанию 35
  --speed-max <mps>       максимальная путевая скорость, по умолчанию 65
  --speed-step <mps>      шаг перебора скорости, по умолчанию 1
  --json                  вывести машинно-читаемый JSON"
    );
}
