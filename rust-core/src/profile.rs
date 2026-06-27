use crate::nmea::RadioAltimeterSample;

pub fn terrain_profile_m(samples: &[RadioAltimeterSample], baro_altitude_m: f64) -> Vec<f64> {
    samples
        .iter()
        .map(|sample| baro_altitude_m - sample.radio_altitude_m)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::nmea::{ChecksumStatus, RadioAltimeterSample};

    #[test]
    fn calculates_terrain_as_baro_minus_radio_altitude() {
        let samples = vec![RadioAltimeterSample {
            time_s: 12.5,
            radio_altitude_m: 545.4,
            sentence: String::new(),
            checksum_status: ChecksumStatus::Ok,
        }];

        let profile = terrain_profile_m(&samples, 1500.0);
        assert!((profile[0] - 954.6).abs() < 0.0001);
    }
}
