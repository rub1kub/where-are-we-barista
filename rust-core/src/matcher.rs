use crate::dem::DemGrid;
use crate::nmea::RadioAltimeterSample;
use crate::profile::terrain_profile_m;
use crate::scoring::{relief_m, standard_deviation_m, ProfileScore};
use serde::Serialize;
use std::time::Instant;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum NavigationStatus {
    #[serde(rename = "VALID")]
    Valid,
    #[serde(rename = "DEGRADED")]
    Degraded,
    #[serde(rename = "AMBIGUOUS")]
    Ambiguous,
    #[serde(rename = "LOW_RELIEF")]
    LowRelief,
    #[serde(rename = "NO_FIX")]
    NoFix,
}

#[derive(Debug, Clone)]
pub struct SearchConfig {
    pub baro_altitude_m: f64,
    pub fallback_sample_rate_hz: f64,
    pub speed_min_mps: f64,
    pub speed_max_mps: f64,
    pub speed_step_mps: f64,
    pub shift_candidates_m: Vec<f64>,
    pub max_profile_samples: usize,
}

impl Default for SearchConfig {
    fn default() -> Self {
        Self {
            baro_altitude_m: 1500.0,
            fallback_sample_rate_hz: 2.0,
            speed_min_mps: 35.0,
            speed_max_mps: 65.0,
            speed_step_mps: 1.0,
            shift_candidates_m: vec![-3000.0, -1500.0, 0.0, 1500.0, 3000.0],
            max_profile_samples: 260,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct MatchResult {
    pub status: NavigationStatus,
    pub x_m: f64,
    pub y_m: f64,
    pub latitude_deg: Option<f64>,
    pub longitude_deg: Option<f64>,
    pub speed_mps: f64,
    pub azimuth_deg: f64,
    pub match_score: f64,
    pub profile_error_m: f64,
    pub confidence: f64,
    pub compute_ms: u128,
}

#[derive(Debug, Clone, Copy)]
struct Candidate {
    azimuth_deg: f64,
    speed_mps: f64,
    shift_m: f64,
    score: ProfileScore,
}

pub fn status_label_ru(status: NavigationStatus) -> &'static str {
    match status {
        NavigationStatus::Valid => "МЕСТО НАЙДЕНО",
        NavigationStatus::Degraded => "ПРИВЯЗКА НЕТОЧНАЯ",
        NavigationStatus::Ambiguous => "НЕСКОЛЬКО ВАРИАНТОВ",
        NavigationStatus::LowRelief => "СЛАБЫЙ РЕЛЬЕФ",
        NavigationStatus::NoFix => "МЕСТО НЕ НАЙДЕНО",
    }
}

pub fn match_samples(
    samples: &[RadioAltimeterSample],
    dem: &DemGrid,
    config: &SearchConfig,
) -> MatchResult {
    let profile = terrain_profile_m(samples, config.baro_altitude_m);
    let times = normalize_sample_times(samples, config.fallback_sample_rate_hz);
    match_profile(&profile, &times, dem, config)
}

pub fn match_profile(
    measured_profile: &[f64],
    sample_times_s: &[f64],
    dem: &DemGrid,
    config: &SearchConfig,
) -> MatchResult {
    let started = Instant::now();
    if measured_profile.len() < 12 || measured_profile.len() != sample_times_s.len() {
        return no_fix(started);
    }

    let indexes = downsample_indexes(measured_profile.len(), config.max_profile_samples);
    let measured: Vec<f64> = indexes
        .iter()
        .map(|index| measured_profile[*index])
        .collect();
    let times: Vec<f64> = indexes.iter().map(|index| sample_times_s[*index]).collect();
    let measured_relief = relief_m(&measured);
    let measured_std = standard_deviation_m(&measured);

    let mut best: Option<Candidate> = None;
    let mut second_score: Option<f64> = None;

    for azimuth_deg in 0..360 {
        let azimuth_deg = azimuth_deg as f64;
        let mut speed_mps = config.speed_min_mps;
        while speed_mps <= config.speed_max_mps + 0.0001 {
            let mut best_for_cell: Option<Candidate> = None;

            for shift_m in &config.shift_candidates_m {
                if let Some(score) =
                    score_candidate(dem, &measured, &times, azimuth_deg, speed_mps, *shift_m)
                {
                    let candidate = Candidate {
                        azimuth_deg,
                        speed_mps,
                        shift_m: *shift_m,
                        score,
                    };
                    if is_better(candidate, best_for_cell) {
                        best_for_cell = Some(candidate);
                    }
                }
            }

            if let Some(candidate) = best_for_cell {
                if is_better(candidate, best) {
                    second_score = best.map(|item| item.score.match_score).or(second_score);
                    best = Some(candidate);
                } else if second_score.map_or(true, |score| candidate.score.match_score > score) {
                    second_score = Some(candidate.score.match_score);
                }
            }

            speed_mps += config.speed_step_mps;
        }
    }

    let Some(best) = best else {
        return no_fix(started);
    };

    let ambiguity =
        (best.score.match_score - second_score.unwrap_or(best.score.match_score - 1.0)).max(0.0);
    let confidence = estimate_confidence(
        best.score.match_score,
        measured_relief,
        ambiguity,
        best.score.profile_error_m,
    );
    let status = classify_status(
        confidence,
        measured_relief,
        measured_std,
        ambiguity,
        best.score.match_score,
        best.score.profile_error_m,
    );
    let final_time_s = *sample_times_s.last().unwrap_or(&0.0);
    let final_distance_m = best.shift_m + best.speed_mps * final_time_s;
    let azimuth = best.azimuth_deg.to_radians();
    let x_m = azimuth.sin() * final_distance_m;
    let y_m = azimuth.cos() * final_distance_m;
    let (lat, lon) = dem.local_to_lat_lon(x_m, y_m);

    MatchResult {
        status,
        x_m,
        y_m,
        latitude_deg: Some(lat),
        longitude_deg: Some(lon),
        speed_mps: best.speed_mps,
        azimuth_deg: best.azimuth_deg,
        match_score: best.score.match_score,
        profile_error_m: best.score.profile_error_m,
        confidence,
        compute_ms: started.elapsed().as_millis(),
    }
}

fn is_better(candidate: Candidate, current: Option<Candidate>) -> bool {
    match current {
        None => true,
        Some(current) => {
            candidate.score.match_score > current.score.match_score
                || ((candidate.score.match_score - current.score.match_score).abs() < f64::EPSILON
                    && candidate.score.profile_error_m < current.score.profile_error_m)
        }
    }
}

fn score_candidate(
    dem: &DemGrid,
    measured: &[f64],
    times: &[f64],
    azimuth_deg: f64,
    speed_mps: f64,
    shift_m: f64,
) -> Option<ProfileScore> {
    let count = measured.len() as f64;
    let measured_mean = measured.iter().sum::<f64>() / count;
    let measured_var = measured
        .iter()
        .map(|value| (value - measured_mean).powi(2))
        .sum::<f64>();
    let azimuth = azimuth_deg.to_radians();
    let sin_azimuth = azimuth.sin();
    let cos_azimuth = azimuth.cos();
    let mut reference_sum = 0.0;
    let mut reference_sq_sum = 0.0;
    let mut cross_sum = 0.0;
    let mut error_sq_sum = 0.0;

    for (index, t) in times.iter().enumerate() {
        let distance_m = shift_m + speed_mps * *t;
        let reference = dem.sample_local_m(sin_azimuth * distance_m, cos_azimuth * distance_m)?;
        let measured_value = measured[index];
        reference_sum += reference;
        reference_sq_sum += reference * reference;
        cross_sum += measured_value * reference;
        let error = measured_value - reference;
        error_sq_sum += error * error;
    }

    let reference_var = reference_sq_sum - (reference_sum * reference_sum) / count;
    let covariance = cross_sum - measured_mean * reference_sum;
    let denominator = (measured_var * reference_var).max(0.0).sqrt();
    Some(ProfileScore {
        match_score: if denominator > 0.0 {
            covariance / denominator
        } else {
            0.0
        },
        profile_error_m: (error_sq_sum / count).sqrt(),
    })
}

fn normalize_sample_times(
    samples: &[RadioAltimeterSample],
    fallback_sample_rate_hz: f64,
) -> Vec<f64> {
    if samples.is_empty() {
        return Vec::new();
    }

    let mut day_offset = 0.0;
    let mut previous = samples[0].time_s;
    let absolute: Vec<f64> = samples
        .iter()
        .enumerate()
        .map(|(index, sample)| {
            if index > 0 && sample.time_s + day_offset < previous - 1.0 {
                day_offset += 86_400.0;
            }
            let value = sample.time_s + day_offset;
            previous = value;
            value
        })
        .collect();
    let first = absolute[0];
    let times: Vec<f64> = absolute.iter().map(|value| value - first).collect();
    let span = *times.last().unwrap_or(&0.0);

    if span <= 0.0001 {
        return samples
            .iter()
            .enumerate()
            .map(|(index, _)| index as f64 / fallback_sample_rate_hz)
            .collect();
    }

    times
}

fn downsample_indexes(length: usize, target_length: usize) -> Vec<usize> {
    let count = length.min(target_length);
    if count <= 1 {
        return vec![0];
    }
    (0..count)
        .map(|index| ((index as f64 * (length - 1) as f64) / (count - 1) as f64).round() as usize)
        .collect()
}

fn estimate_confidence(correlation: f64, relief: f64, ambiguity: f64, profile_error_m: f64) -> f64 {
    let corr_score = ((correlation - 0.55) / 0.44).clamp(0.0, 1.0);
    let relief_score = ((relief - 35.0) / 210.0).clamp(0.0, 1.0);
    let peak_score = (ambiguity / 0.02).clamp(0.0, 1.0);
    let error_score = (1.0 - profile_error_m / 65.0).clamp(0.0, 1.0);
    (0.46 * corr_score + 0.22 * relief_score + 0.12 * peak_score + 0.20 * error_score) * 100.0
}

fn classify_status(
    confidence: f64,
    relief: f64,
    terrain_std: f64,
    ambiguity: f64,
    correlation: f64,
    profile_error_m: f64,
) -> NavigationStatus {
    if !correlation.is_finite() || !profile_error_m.is_finite() {
        return NavigationStatus::NoFix;
    }
    if relief < 35.0 || terrain_std < 9.0 {
        return NavigationStatus::LowRelief;
    }
    if confidence < 18.0 || correlation < 0.42 || profile_error_m > 180.0 {
        return NavigationStatus::NoFix;
    }
    if ambiguity < 0.008 {
        return NavigationStatus::Ambiguous;
    }
    if confidence < 72.0 || correlation < 0.78 || profile_error_m > 80.0 {
        return NavigationStatus::Degraded;
    }
    NavigationStatus::Valid
}

fn no_fix(started: Instant) -> MatchResult {
    MatchResult {
        status: NavigationStatus::NoFix,
        x_m: 0.0,
        y_m: 0.0,
        latitude_deg: None,
        longitude_deg: None,
        speed_mps: 0.0,
        azimuth_deg: 0.0,
        match_score: 0.0,
        profile_error_m: f64::INFINITY,
        confidence: 0.0,
        compute_ms: started.elapsed().as_millis(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dem::DemGrid;
    use crate::nmea::parse_nmea_stream;
    use std::fs;

    #[test]
    fn control_log_finds_expected_direction() {
        let dem = DemGrid::load("data/dem-sample.json").unwrap();
        let text = fs::read_to_string("data/control-radio-altimeter.nmea").unwrap();
        let report = parse_nmea_stream(&text);
        let result = match_samples(&report.samples, &dem, &SearchConfig::default());

        assert!(matches!(
            result.status,
            NavigationStatus::Valid | NavigationStatus::Degraded
        ));
        assert!((result.azimuth_deg - 73.0).abs() <= 2.0);
        assert!((result.speed_mps - 44.0).abs() <= 1.0);
        assert!(result.x_m.is_finite() && result.y_m.is_finite());
        assert!(result.latitude_deg.unwrap().is_finite());
        assert!(result.longitude_deg.unwrap().is_finite());
        assert!(result.confidence > 70.0);
    }

    #[test]
    fn flat_relief_drops_status() {
        let dem = DemGrid::flat_for_tests(320.0);
        let samples: Vec<RadioAltimeterSample> = (0..64)
            .map(|index| RadioAltimeterSample {
                time_s: index as f64,
                radio_altitude_m: 1180.0,
                sentence: String::new(),
                checksum_status: crate::nmea::ChecksumStatus::Ok,
            })
            .collect();
        let mut config = SearchConfig::default();
        config.speed_min_mps = 35.0;
        config.speed_max_mps = 36.0;
        let result = match_samples(&samples, &dem, &config);

        assert!(matches!(
            result.status,
            NavigationStatus::LowRelief | NavigationStatus::NoFix
        ));
        assert!(result.confidence < 50.0);
    }

    #[test]
    fn incompatible_profile_returns_no_fix() {
        let dem = DemGrid::load("data/dem-sample.json").unwrap();
        let measured: Vec<f64> = (0..96)
            .map(|index| if index % 2 == 0 { 980.0 } else { -120.0 })
            .collect();
        let times: Vec<f64> = (0..96).map(|index| index as f64 / 2.0).collect();
        let mut config = SearchConfig::default();
        config.max_profile_samples = 96;
        let result = match_profile(&measured, &times, &dem, &config);

        assert_eq!(result.status, NavigationStatus::NoFix);
    }
}
