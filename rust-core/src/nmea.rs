#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChecksumStatus {
    Ok,
    Missing,
    Invalid,
}

#[derive(Debug, Clone)]
pub struct RadioAltimeterSample {
    pub time_s: f64,
    pub radio_altitude_m: f64,
    pub sentence: String,
    pub checksum_status: ChecksumStatus,
}

#[derive(Debug, Clone, Default)]
pub struct NmeaParseReport {
    pub samples: Vec<RadioAltimeterSample>,
    pub skipped_lines: usize,
    pub checksum_ok: usize,
    pub checksum_missing: usize,
    pub checksum_invalid: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NmeaError {
    Empty,
    UnsupportedSentence(String),
    MissingRadioAltitude,
}

pub fn nmea_checksum(payload: &str) -> u8 {
    payload.bytes().fold(0_u8, |acc, byte| acc ^ byte)
}

fn checksum_hex(value: u8) -> String {
    format!("{value:02X}")
}

fn parse_nmea_time(value: &str) -> f64 {
    if value.len() < 6 {
        return 0.0;
    }

    let hours = value[0..2].parse::<f64>().unwrap_or(0.0);
    let minutes = value[2..4].parse::<f64>().unwrap_or(0.0);
    let seconds = value[4..].parse::<f64>().unwrap_or(0.0);
    hours * 3600.0 + minutes * 60.0 + seconds
}

pub fn parse_gga_sentence(sentence: &str) -> Result<RadioAltimeterSample, NmeaError> {
    let trimmed = sentence.trim();
    if trimmed.is_empty() {
        return Err(NmeaError::Empty);
    }

    let body = trimmed.strip_prefix('$').unwrap_or(trimmed);
    let (payload, provided_checksum) = match body.split_once('*') {
        Some((payload, checksum)) => (payload, Some(checksum.trim().to_uppercase())),
        None => (body, None),
    };
    let fields: Vec<&str> = payload.split(',').collect();
    let sentence_type = fields.first().copied().unwrap_or_default();

    if sentence_type != "GPGGA" && sentence_type != "GNGGA" {
        return Err(NmeaError::UnsupportedSentence(sentence_type.to_string()));
    }

    let radio_altitude_m = fields
        .get(9)
        .and_then(|value| value.parse::<f64>().ok())
        .ok_or(NmeaError::MissingRadioAltitude)?;

    let expected = checksum_hex(nmea_checksum(payload));
    let checksum_status = match provided_checksum {
        Some(value) if value == expected => ChecksumStatus::Ok,
        Some(_) => ChecksumStatus::Invalid,
        None => ChecksumStatus::Missing,
    };

    Ok(RadioAltimeterSample {
        time_s: parse_nmea_time(fields.get(1).copied().unwrap_or("0")),
        radio_altitude_m,
        sentence: trimmed.to_string(),
        checksum_status,
    })
}

pub fn parse_nmea_stream(text: &str) -> NmeaParseReport {
    let mut report = NmeaParseReport::default();

    for line in text.lines().map(str::trim).filter(|line| !line.is_empty()) {
        match parse_gga_sentence(line) {
            Ok(sample) => {
                match sample.checksum_status {
                    ChecksumStatus::Ok => report.checksum_ok += 1,
                    ChecksumStatus::Missing => report.checksum_missing += 1,
                    ChecksumStatus::Invalid => report.checksum_invalid += 1,
                }
                report.samples.push(sample);
            }
            Err(_) => {
                report.skipped_lines += 1;
            }
        }
    }

    report
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_case_shape_and_marks_checksum() {
        let sample = parse_gga_sentence("$GPGGA,123519.111,,,,,,,,545.4,M,46.9,M,,*47").unwrap();
        assert_eq!(sample.radio_altitude_m, 545.4);
        assert_eq!(sample.checksum_status, ChecksumStatus::Invalid);
        assert_eq!(
            checksum_hex(nmea_checksum("GPGGA,123519.111,,,,,,,,545.4,M,46.9,M,,")),
            "7F"
        );
    }
}
