#[derive(Debug, Clone, Copy)]
pub struct ProfileScore {
    pub match_score: f64,
    pub profile_error_m: f64,
}

pub fn score_profiles(measured: &[f64], reference: &[f64]) -> Option<ProfileScore> {
    if measured.is_empty() || measured.len() != reference.len() {
        return None;
    }

    let count = measured.len() as f64;
    let measured_mean = measured.iter().sum::<f64>() / count;
    let reference_mean = reference.iter().sum::<f64>() / count;
    let mut measured_var = 0.0;
    let mut reference_var = 0.0;
    let mut covariance = 0.0;
    let mut error_sq = 0.0;

    for (m, r) in measured.iter().zip(reference.iter()) {
        let dm = *m - measured_mean;
        let dr = *r - reference_mean;
        measured_var += dm * dm;
        reference_var += dr * dr;
        covariance += dm * dr;
        let error = *m - *r;
        error_sq += error * error;
    }

    let denominator = (measured_var * reference_var).max(0.0).sqrt();
    Some(ProfileScore {
        match_score: if denominator > 0.0 {
            covariance / denominator
        } else {
            0.0
        },
        profile_error_m: (error_sq / count).sqrt(),
    })
}

pub(crate) fn relief_m(profile: &[f64]) -> f64 {
    if profile.is_empty() {
        return 0.0;
    }
    let min = profile.iter().copied().fold(f64::INFINITY, f64::min);
    let max = profile.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    max - min
}

pub(crate) fn standard_deviation_m(profile: &[f64]) -> f64 {
    if profile.is_empty() {
        return 0.0;
    }
    let count = profile.len() as f64;
    let mean = profile.iter().sum::<f64>() / count;
    let variance = profile
        .iter()
        .map(|value| (value - mean).powi(2))
        .sum::<f64>()
        / count;
    variance.sqrt()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identical_profiles_have_high_match() {
        let profile = [300.0, 320.0, 360.0, 330.0, 310.0];
        let score = score_profiles(&profile, &profile).unwrap();
        assert!(score.match_score > 0.999);
        assert!(score.profile_error_m < 0.001);
    }

    #[test]
    fn different_profiles_have_low_match() {
        let measured = [300.0, 320.0, 360.0, 330.0, 310.0];
        let reference = [310.0, 330.0, 300.0, 360.0, 320.0];
        let score = score_profiles(&measured, &reference).unwrap();
        assert!(score.match_score < 0.25);
        assert!(score.profile_error_m > 25.0);
    }
}
