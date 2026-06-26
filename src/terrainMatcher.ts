import {
  RadioAltimeterSample,
  buildGgaRadioSentence,
  parseGgaRadioSentence,
} from "./nmeaRadioAltimeter";
import { COPERNICUS_TAIGA_DEM } from "./copernicusDemSample";

export type TerrainKind = "taiga" | "flat" | "mountain";

export type MatcherConfig = {
  terrainKind: TerrainKind;
  baroAltitudeM: number;
  sampleRateHz: number;
  durationS: number;
  trueSpeedMps: number;
  trueAzimuthDeg: number;
  radioNoiseM: number;
  speedMinMps: number;
  speedMaxMps: number;
  speedStepMps: number;
};

export type MatchPoint = {
  t: number;
  x: number;
  y: number;
  elevationM: number;
};

export type Wgs84Point = {
  lat: number;
  lon: number;
};

export type MatchCandidate = {
  azimuthDeg: number;
  speedMps: number;
  shiftM: number;
  correlation: number;
  rmseM: number;
  confidence: number;
};

export type HeatmapCell = {
  azimuthDeg: number;
  speedMps: number;
  shiftM: number;
  correlation: number;
  rmseM: number;
};

export type TerrainMatchResult = {
  config: MatcherConfig;
  nmea: string[];
  samples: RadioAltimeterSample[];
  measuredProfile: number[];
  referenceProfile: number[];
  truthPath: MatchPoint[];
  estimatedPath: MatchPoint[];
  heatmap: HeatmapCell[];
  best: MatchCandidate;
  finalErrorM: number;
  meanErrorM: number;
  terrainReliefM: number;
  ambiguity: number;
  computeMs: number;
};

export const TAIGA_ROUTE = {
  region: "Красноярский край, средняя тайга",
  routeName: "Ванавара → геологоразведочный лагерь",
  startName: "Ванавара",
  finishName: "лагерь",
  riverName: "Подкаменная Тунгуска",
  demName: "Copernicus DEM GLO-30 / сэмпл ЦМР",
  start: {
    lat: 60.3446,
    lon: 102.2797,
  },
  note: "Гражданская доставка груза в район без плотной наземной инфраструктуры.",
};

const SHIFT_CANDIDATES_M = [-3000, -1500, 0, 1500, 3000];

export const DEFAULT_MATCHER_CONFIG: MatcherConfig = {
  terrainKind: "taiga",
  baroAltitudeM: 1500,
  sampleRateHz: 2,
  durationS: 4200,
  trueSpeedMps: 44,
  trueAzimuthDeg: 73,
  radioNoiseM: 3,
  speedMinMps: 35,
  speedMaxMps: 65,
  speedStepMps: 1,
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function deterministicNoise(index: number, amplitudeM: number): number {
  if (amplitudeM <= 0) return 0;
  const base = Math.sin(index * 12.9898 + 78.233) * 43758.5453;
  const fractional = base - Math.floor(base);
  const slow = Math.sin(index * 0.023) * 0.45 + Math.cos(index * 0.011) * 0.25;
  return (fractional * 2 - 1 + slow) * amplitudeM;
}

function gaussian(x: number, y: number, centerX: number, centerY: number, sigmaX: number, sigmaY: number, amplitude: number): number {
  const dx = Math.pow((x - centerX) / sigmaX, 2);
  const dy = Math.pow((y - centerY) / sigmaY, 2);
  return Math.exp(-(dx + dy)) * amplitude;
}

function sampleCopernicusTaigaDemMsl(x: number, y: number): number | null {
  const point = localPointToWgs84({ x, y });
  const { bounds, width, height, elevationM } = COPERNICUS_TAIGA_DEM;

  if (point.lat < bounds.latMin || point.lat > bounds.latMax || point.lon < bounds.lonMin || point.lon > bounds.lonMax) {
    return null;
  }

  const px = ((point.lon - bounds.lonMin) / (bounds.lonMax - bounds.lonMin)) * (width - 1);
  const py = ((bounds.latMax - point.lat) / (bounds.latMax - bounds.latMin)) * (height - 1);
  const x0 = Math.max(0, Math.min(width - 1, Math.floor(px)));
  const y0 = Math.max(0, Math.min(height - 1, Math.floor(py)));
  const x1 = Math.max(0, Math.min(width - 1, x0 + 1));
  const y1 = Math.max(0, Math.min(height - 1, y0 + 1));
  const tx = px - x0;
  const ty = py - y0;
  const i00 = y0 * width + x0;
  const i10 = y0 * width + x1;
  const i01 = y1 * width + x0;
  const i11 = y1 * width + x1;
  const top = elevationM[i00] * (1 - tx) + elevationM[i10] * tx;
  const bottom = elevationM[i01] * (1 - tx) + elevationM[i11] * tx;
  return top * (1 - ty) + bottom * ty;
}

export function terrainElevationMsl(kind: TerrainKind, x: number, y: number): number {
  const xKm = x / 1000;
  const yKm = y / 1000;
  const longRidge = Math.sin(xKm * 0.047 + yKm * 0.093);
  const crossRidge = Math.cos(xKm * 0.082 - yKm * 0.051);
  const fine = Math.sin(xKm * 0.31) * Math.cos(yKm * 0.29);

  if (kind === "flat") {
    return 260 + longRidge * 10 + crossRidge * 8 + fine * 5;
  }

  if (kind === "mountain") {
    return 760 + longRidge * 180 + crossRidge * 120 + fine * 70 + gaussian(xKm, yKm, 72, 18, 22, 12, 190);
  }

  const copernicusElevation = sampleCopernicusTaigaDemMsl(x, y);
  if (copernicusElevation !== null) {
    return copernicusElevation;
  }

  const riverValley = -gaussian(xKm, yKm, 58, 14, 75, 5, 64);
  const lakesAndBogs =
    gaussian(xKm, yKm, 28, 9, 12, 8, 35) -
    gaussian(xKm, yKm, 94, 28, 14, 10, 42) +
    gaussian(xKm, yKm, 138, 43, 16, 10, 46);
  const taigaFingerprints =
    gaussian(xKm, yKm, 36, 11, 7, 5, 50) -
    gaussian(xKm, yKm, 63, 20, 8, 7, 58) +
    gaussian(xKm, yKm, 106, 32, 9, 6, 72) -
    gaussian(xKm, yKm, 151, 47, 9, 7, 62);

  return 410 + longRidge * 82 + crossRidge * 46 + fine * 24 + riverValley + lakesAndBogs + taigaFingerprints;
}

function projectPoint(kind: TerrainKind, azimuthDeg: number, distanceM: number, t: number): MatchPoint {
  const azimuth = degToRad(azimuthDeg);
  const x = Math.sin(azimuth) * distanceM;
  const y = Math.cos(azimuth) * distanceM;
  return {
    t,
    x,
    y,
    elevationM: terrainElevationMsl(kind, x, y),
  };
}

export function localPointToWgs84(point: Pick<MatchPoint, "x" | "y">): Wgs84Point {
  const metersPerDegreeLat = 111_320;
  const lat = TAIGA_ROUTE.start.lat + point.y / metersPerDegreeLat;
  const metersPerDegreeLon = metersPerDegreeLat * Math.cos(degToRad(TAIGA_ROUTE.start.lat));
  const lon = TAIGA_ROUTE.start.lon + point.x / metersPerDegreeLon;
  return { lat, lon };
}

function horizontalDistance(a: Pick<MatchPoint, "x" | "y">, b: Pick<MatchPoint, "x" | "y">): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function buildProfile(kind: TerrainKind, times: number[], azimuthDeg: number, speedMps: number, shiftM: number): number[] {
  return times.map((t) => {
    const point = projectPoint(kind, azimuthDeg, shiftM + speedMps * t, t);
    return point.elevationM;
  });
}

function scoreProfile(
  kind: TerrainKind,
  times: number[],
  measured: number[],
  measuredMean: number,
  measuredVariance: number,
  azimuthDeg: number,
  speedMps: number,
  shiftM: number,
): { correlation: number; rmseM: number } {
  const azimuth = degToRad(azimuthDeg);
  const sinAzimuth = Math.sin(azimuth);
  const cosAzimuth = Math.cos(azimuth);
  let sumReference = 0;
  let sumReferenceSq = 0;
  let sumCross = 0;
  let sumErrorSq = 0;

  for (let i = 0; i < times.length; i += 1) {
    const distanceM = shiftM + speedMps * times[i];
    const elevation = terrainElevationMsl(kind, sinAzimuth * distanceM, cosAzimuth * distanceM);
    const measuredValue = measured[i];
    const error = measuredValue - elevation;
    sumReference += elevation;
    sumReferenceSq += elevation * elevation;
    sumCross += measuredValue * elevation;
    sumErrorSq += error * error;
  }

  const referenceVariance = sumReferenceSq - (sumReference * sumReference) / Math.max(1, times.length);
  const covariance = sumCross - measuredMean * sumReference;
  const denominator = Math.sqrt(Math.max(0, measuredVariance * referenceVariance));

  return {
    correlation: denominator > 0 ? covariance / denominator : 0,
    rmseM: Math.sqrt(sumErrorSq / Math.max(1, times.length)),
  };
}

function downsampleIndexes(length: number, targetLength: number): number[] {
  const count = Math.min(length, targetLength);
  if (count <= 1) return [0];
  return Array.from({ length: count }, (_, index) => Math.round((index * (length - 1)) / (count - 1)));
}

function measuredRelief(profile: number[]): number {
  return Math.max(...profile) - Math.min(...profile);
}

function estimateConfidence(correlation: number, reliefM: number, ambiguity: number, rmseM: number): number {
  const corrScore = clamp((correlation - 0.55) / 0.44, 0, 1);
  const reliefScore = clamp((reliefM - 35) / 210, 0, 1);
  const peakScore = clamp(ambiguity / 0.02, 0, 1);
  const rmseScore = clamp(1 - rmseM / 65, 0, 1);
  return Math.round((0.46 * corrScore + 0.22 * reliefScore + 0.12 * peakScore + 0.2 * rmseScore) * 100);
}

export function routeLengthM(path: MatchPoint[]): number {
  let total = 0;
  for (let i = 1; i < path.length; i += 1) {
    total += horizontalDistance(path[i], path[i - 1]);
  }
  return total;
}

export function runTerrainMatching(config: MatcherConfig): TerrainMatchResult {
  const startTime = performance.now();
  const sampleCount = Math.max(12, Math.round(config.durationS * config.sampleRateHz) + 1);
  const dt = 1 / config.sampleRateHz;

  const truthPath: MatchPoint[] = Array.from({ length: sampleCount }, (_, index) =>
    projectPoint(config.terrainKind, config.trueAzimuthDeg, config.trueSpeedMps * index * dt, index * dt),
  );

  const nmea = truthPath.map((point, index) => {
    const radioAltitude = Math.max(25, config.baroAltitudeM - point.elevationM + deterministicNoise(index, config.radioNoiseM));
    return buildGgaRadioSentence(point.t, radioAltitude);
  });

  const samples = nmea.map((sentence) => parseGgaRadioSentence(sentence, config.baroAltitudeM));
  const measuredProfile = samples.map((sample) => sample.terrainMslM);
  const terrainReliefM = measuredRelief(measuredProfile);
  const indexes = downsampleIndexes(sampleCount, 260);
  const matchTimes = indexes.map((index) => truthPath[index].t);
  const measuredMatchProfile = indexes.map((index) => measuredProfile[index]);
  const measuredSum = measuredMatchProfile.reduce((sum, value) => sum + value, 0);
  const measuredMean = measuredSum / Math.max(1, measuredMatchProfile.length);
  const measuredVariance =
    measuredMatchProfile.reduce((sum, value) => sum + value * value, 0) -
    (measuredSum * measuredSum) / Math.max(1, measuredMatchProfile.length);

  let bestCell: HeatmapCell = {
    azimuthDeg: 0,
    speedMps: config.speedMinMps,
    shiftM: 0,
    correlation: -1,
    rmseM: Number.POSITIVE_INFINITY,
  };
  let secondCorrelation = -1;
  const heatmap: HeatmapCell[] = [];

  for (let azimuthDeg = 0; azimuthDeg < 360; azimuthDeg += 1) {
    for (let speedMps = config.speedMinMps; speedMps <= config.speedMaxMps + 0.0001; speedMps += config.speedStepMps) {
      let cell: HeatmapCell = {
        azimuthDeg,
        speedMps: Math.round(speedMps * 10) / 10,
        shiftM: 0,
        correlation: -1,
        rmseM: Number.POSITIVE_INFINITY,
      };

      for (const shiftM of SHIFT_CANDIDATES_M) {
        const { correlation, rmseM } = scoreProfile(
          config.terrainKind,
          matchTimes,
          measuredMatchProfile,
          measuredMean,
          measuredVariance,
          azimuthDeg,
          speedMps,
          shiftM,
        );

        if (correlation > cell.correlation || (correlation === cell.correlation && rmseM < cell.rmseM)) {
          cell = {
            azimuthDeg,
            speedMps: Math.round(speedMps * 10) / 10,
            shiftM,
            correlation,
            rmseM,
          };
        }
      }

      heatmap.push(cell);

      if (cell.correlation > bestCell.correlation || (cell.correlation === bestCell.correlation && cell.rmseM < bestCell.rmseM)) {
        secondCorrelation = bestCell.correlation;
        bestCell = cell;
      } else if (cell.correlation > secondCorrelation) {
        secondCorrelation = cell.correlation;
      }
    }
  }

  const ambiguity = Math.max(0, bestCell.correlation - secondCorrelation);
  const confidence = estimateConfidence(bestCell.correlation, terrainReliefM, ambiguity, bestCell.rmseM);
  const best: MatchCandidate = {
    ...bestCell,
    confidence,
  };

  const estimatedPath: MatchPoint[] = truthPath.map((point) =>
    projectPoint(config.terrainKind, best.azimuthDeg, best.shiftM + best.speedMps * point.t, point.t),
  );
  const referenceProfile = estimatedPath.map((point) => point.elevationM);
  const errors = estimatedPath.map((point, index) => horizontalDistance(point, truthPath[index]));

  return {
    config,
    nmea,
    samples,
    measuredProfile,
    referenceProfile,
    truthPath,
    estimatedPath,
    heatmap,
    best,
    finalErrorM: errors[errors.length - 1] ?? 0,
    meanErrorM: errors.reduce((sum, value) => sum + value, 0) / Math.max(1, errors.length),
    terrainReliefM,
    ambiguity,
    computeMs: performance.now() - startTime,
  };
}
