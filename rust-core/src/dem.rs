use serde::{Deserialize, Serialize};
use std::error::Error;
use std::fs;
use std::path::Path;

const DEFAULT_ORIGIN_LAT: f64 = 60.3446;
const DEFAULT_ORIGIN_LON: f64 = 102.2797;
const METERS_PER_DEGREE_LAT: f64 = 111_320.0;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DemGrid {
    pub width: usize,
    pub height: usize,
    pub min_lat: f64,
    pub max_lat: f64,
    pub min_lon: f64,
    pub max_lon: f64,
    #[serde(default = "default_origin_lat")]
    pub origin_lat: f64,
    #[serde(default = "default_origin_lon")]
    pub origin_lon: f64,
    pub heights_m: Vec<f64>,
}

fn default_origin_lat() -> f64 {
    DEFAULT_ORIGIN_LAT
}

fn default_origin_lon() -> f64 {
    DEFAULT_ORIGIN_LON
}

impl DemGrid {
    pub fn load(path: impl AsRef<Path>) -> Result<Self, Box<dyn Error>> {
        let text = fs::read_to_string(path)?;
        let dem: DemGrid = serde_json::from_str(&text)?;
        dem.validate()?;
        Ok(dem)
    }

    pub fn validate(&self) -> Result<(), Box<dyn Error>> {
        if self.width == 0 || self.height == 0 {
            return Err("DEM grid width/height must be positive".into());
        }
        if self.heights_m.len() != self.width * self.height {
            return Err(format!(
                "DEM height count mismatch: expected {}, got {}",
                self.width * self.height,
                self.heights_m.len()
            )
            .into());
        }
        Ok(())
    }

    pub fn local_to_lat_lon(&self, x_m: f64, y_m: f64) -> (f64, f64) {
        let lat = self.origin_lat + y_m / METERS_PER_DEGREE_LAT;
        let meters_per_degree_lon = METERS_PER_DEGREE_LAT * self.origin_lat.to_radians().cos();
        let lon = self.origin_lon + x_m / meters_per_degree_lon;
        (lat, lon)
    }

    pub fn sample_local_m(&self, x_m: f64, y_m: f64) -> Option<f64> {
        let (lat, lon) = self.local_to_lat_lon(x_m, y_m);
        self.sample_lat_lon(lat, lon)
    }

    pub fn sample_lat_lon(&self, lat: f64, lon: f64) -> Option<f64> {
        if lat < self.min_lat || lat > self.max_lat || lon < self.min_lon || lon > self.max_lon {
            return None;
        }

        let px = ((lon - self.min_lon) / (self.max_lon - self.min_lon))
            * (self.width.saturating_sub(1) as f64);
        let py = ((self.max_lat - lat) / (self.max_lat - self.min_lat))
            * (self.height.saturating_sub(1) as f64);
        let x0 = px.floor().clamp(0.0, (self.width - 1) as f64) as usize;
        let y0 = py.floor().clamp(0.0, (self.height - 1) as f64) as usize;
        let x1 = (x0 + 1).min(self.width - 1);
        let y1 = (y0 + 1).min(self.height - 1);
        let tx = px - x0 as f64;
        let ty = py - y0 as f64;

        let i00 = y0 * self.width + x0;
        let i10 = y0 * self.width + x1;
        let i01 = y1 * self.width + x0;
        let i11 = y1 * self.width + x1;
        let top = self.heights_m[i00] * (1.0 - tx) + self.heights_m[i10] * tx;
        let bottom = self.heights_m[i01] * (1.0 - tx) + self.heights_m[i11] * tx;
        Some(top * (1.0 - ty) + bottom * ty)
    }

    pub fn flat_for_tests(height_m: f64) -> Self {
        Self {
            width: 8,
            height: 8,
            min_lat: 60.25,
            max_lat: 60.95,
            min_lon: 102.15,
            max_lon: 105.65,
            origin_lat: DEFAULT_ORIGIN_LAT,
            origin_lon: DEFAULT_ORIGIN_LON,
            heights_m: vec![height_m; 64],
        }
    }
}
