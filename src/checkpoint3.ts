import { fromArrayBuffer } from "geotiff";
import { COPERNICUS_TAIGA_DEM } from "./copernicusDemSample";
import { DEFAULT_MATCHER_CONFIG, TAIGA_ROUTE, simulateFlight, localPointToWgs84, type Wgs84Point } from "./terrainMatcher";

export type CheckpointCoordinateMode = "taiga-local" | "wgs84" | "projected" | "unknown";

export type CheckpointDem = {
  name: string;
  width: number;
  height: number;
  values: number[];
  minElevationM: number;
  maxElevationM: number;
  noDataValue: number | null;
  bbox: {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  } | null;
  coordinateMode: CheckpointCoordinateMode;
  crsLabel: string;
};

export type CheckpointTrajectoryPoint = {
  index: number;
  distanceM: number;
  x: number;
  y: number;
  radioAltitudeM: number;
  terrainMslM: number;
  measuredHeightM: number;
  demHeightM: number | null;
  residualM: number | null;
  lat: number | null;
  lon: number | null;
};

export type CheckpointTrajectoryResult = {
  inputSamples: number;
  baroAltitudeM: number;
  speedMps: number;
  sampleRateHz: number;
  sampleDistanceM: number;
  routeLengthM: number;
  azimuthDeg: number;
  startX: number;
  startY: number;
  points: CheckpointTrajectoryPoint[];
  profileRmseM: number | null;
  profileMaeM: number | null;
  profileMaxErrorM: number | null;
  profileCorrelation: number | null;
  coverageRatio: number;
  confidence: number;
  status: "TRAJECTORY READY" | "PROFILE MISMATCH" | "DEM UNAVAILABLE";
  statusReason: string;
  demName: string;
  crsLabel: string;
  computedAt: string;
  computeMs: number;
};

export type BuildCheckpointTrajectoryInput = {
  heightsM: number[];
  dem: CheckpointDem | null;
  startX: number;
  startY: number;
  azimuthDeg: number;
  baroAltitudeM?: number;
  speedMps?: number;
  sampleRateHz?: number;
  sampleDistanceM?: number;
  autoFitStep?: boolean;
  stepMinM?: number;
  stepMaxM?: number;
  stepResolutionM?: number;
};

function nowMs(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}

function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function toFiniteNumber(raw: string): number | null {
  const normalized = raw.trim().replace(",", ".");
  if (!normalized) return null;
  const value = Number(normalized);
  return Number.isFinite(value) ? value : Number.NaN;
}

export function parseCheckpointHeights(text: string): number[] {
  const rows = text.split(/\r?\n/);
  const heights: number[] = [];

  rows.forEach((row, index) => {
    const value = toFiniteNumber(row);
    if (value === null) return;
    if (Number.isNaN(value)) {
      throw new Error(`Строка ${index + 1}: ожидалась радиовысота в метрах.`);
    }
    heights.push(value);
  });

  if (heights.length < 2) {
    throw new Error("Нужен TXT-файл минимум с двумя радиовысотами.");
  }

  return heights;
}

function rasterIndex(dem: CheckpointDem, col: number, row: number): number {
  return row * dem.width + col;
}

function sampleRasterByPixel(dem: CheckpointDem, colFloat: number, rowFloat: number): number | null {
  if (colFloat < 0 || rowFloat < 0 || colFloat > dem.width - 1 || rowFloat > dem.height - 1) return null;

  const x0 = clamp(Math.floor(colFloat), 0, dem.width - 1);
  const y0 = clamp(Math.floor(rowFloat), 0, dem.height - 1);
  const x1 = clamp(x0 + 1, 0, dem.width - 1);
  const y1 = clamp(y0 + 1, 0, dem.height - 1);
  const tx = colFloat - x0;
  const ty = rowFloat - y0;
  const values = [
    dem.values[rasterIndex(dem, x0, y0)],
    dem.values[rasterIndex(dem, x1, y0)],
    dem.values[rasterIndex(dem, x0, y1)],
    dem.values[rasterIndex(dem, x1, y1)],
  ];
  if (values.some((value) => !Number.isFinite(value))) return null;

  const top = values[0] * (1 - tx) + values[1] * tx;
  const bottom = values[2] * (1 - tx) + values[3] * tx;
  return top * (1 - ty) + bottom * ty;
}

export function sampleCheckpointDem(dem: CheckpointDem, x: number, y: number): number | null {
  if (!dem.bbox) return null;
  const col = ((x - dem.bbox.minX) / Math.max(1e-9, dem.bbox.maxX - dem.bbox.minX)) * (dem.width - 1);
  const row = ((dem.bbox.maxY - y) / Math.max(1e-9, dem.bbox.maxY - dem.bbox.minY)) * (dem.height - 1);
  return sampleRasterByPixel(dem, col, row);
}

function pointToWgs84(dem: CheckpointDem | null, x: number, y: number): Wgs84Point | null {
  if (!dem) return null;
  if (dem.coordinateMode === "taiga-local") return localPointToWgs84({ x, y });
  if (dem.coordinateMode === "wgs84") return { lat: y, lon: x };
  return null;
}

function rmse(values: Array<number | null>): number | null {
  const finite = values.filter((value): value is number => Number.isFinite(value));
  if (finite.length === 0) return null;
  return Math.sqrt(finite.reduce((sum, value) => sum + value * value, 0) / finite.length);
}

function mae(values: Array<number | null>): number | null {
  const finite = values.filter((value): value is number => Number.isFinite(value));
  if (finite.length === 0) return null;
  return finite.reduce((sum, value) => sum + Math.abs(value), 0) / finite.length;
}

function maxAbs(values: Array<number | null>): number | null {
  const finite = values.filter((value): value is number => Number.isFinite(value));
  if (finite.length === 0) return null;
  return finite.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
}

function profileCorrelation(points: CheckpointTrajectoryPoint[]): number | null {
  const pairs = points
    .filter((point) => point.demHeightM !== null)
    .map((point) => [point.terrainMslM, point.demHeightM as number] as const);
  if (pairs.length < 3) return null;

  const measuredMean = pairs.reduce((sum, pair) => sum + pair[0], 0) / pairs.length;
  const demMean = pairs.reduce((sum, pair) => sum + pair[1], 0) / pairs.length;
  let numerator = 0;
  let measuredVariance = 0;
  let demVariance = 0;

  pairs.forEach(([measured, dem]) => {
    const measuredDelta = measured - measuredMean;
    const demDelta = dem - demMean;
    numerator += measuredDelta * demDelta;
    measuredVariance += measuredDelta * measuredDelta;
    demVariance += demDelta * demDelta;
  });

  const denominator = Math.sqrt(measuredVariance * demVariance);
  if (denominator <= 1e-9) return null;
  return clamp(numerator / denominator, -1, 1);
}

function checkpointConfidence(profileRmseM: number | null, correlation: number | null, coverageRatio: number): number {
  const rmseScore = profileRmseM === null ? 0 : clamp(1 - profileRmseM / 80, 0, 1);
  const correlationScore = correlation === null ? 0 : clamp((correlation - 0.45) / 0.55, 0, 1);
  const coverageScore = clamp(coverageRatio, 0, 1);
  return Math.round((rmseScore * 0.45 + correlationScore * 0.35 + coverageScore * 0.2) * 100);
}

function buildPoints(
  heightsM: number[],
  dem: CheckpointDem | null,
  startX: number,
  startY: number,
  azimuthDeg: number,
  sampleDistanceM: number,
  baroAltitudeM: number,
): CheckpointTrajectoryPoint[] {
  const azimuth = degToRad(azimuthDeg);
  const sinAzimuth = Math.sin(azimuth);
  const cosAzimuth = Math.cos(azimuth);

  return heightsM.map((radioAltitudeM, index) => {
    const distanceM = index * sampleDistanceM;
    const x = startX + sinAzimuth * distanceM;
    const y = startY + cosAzimuth * distanceM;
    const terrainMslM = baroAltitudeM - radioAltitudeM;
    const demHeightM = dem ? sampleCheckpointDem(dem, x, y) : null;
    const wgs = pointToWgs84(dem, x, y);

    return {
      index,
      distanceM,
      x,
      y,
      radioAltitudeM,
      terrainMslM,
      measuredHeightM: terrainMslM,
      demHeightM,
      residualM: demHeightM === null ? null : terrainMslM - demHeightM,
      lat: wgs?.lat ?? null,
      lon: wgs?.lon ?? null,
    };
  });
}

function fitSampleDistanceM(input: BuildCheckpointTrajectoryInput): number {
  const fallback = input.sampleDistanceM ?? (
    input.speedMps && input.sampleRateHz && input.sampleRateHz > 0
      ? input.speedMps / input.sampleRateHz
      : 22
  );
  if (!input.autoFitStep || !input.dem || !input.dem.bbox) return fallback;

  const stepMinM = input.stepMinM ?? 5;
  const stepMaxM = input.stepMaxM ?? 90;
  const stepResolutionM = input.stepResolutionM ?? 1;
  const baroAltitudeM = input.baroAltitudeM ?? DEFAULT_MATCHER_CONFIG.baroAltitudeM;
  let bestStepM = fallback;
  let bestRmse = Number.POSITIVE_INFINITY;
  const fitHeights = input.heightsM.slice(0, Math.min(input.heightsM.length, 520));

  for (let step = stepMinM; step <= stepMaxM + 0.0001; step += stepResolutionM) {
    const points = buildPoints(fitHeights, input.dem, input.startX, input.startY, input.azimuthDeg, step, baroAltitudeM);
    const residualRmse = rmse(points.map((point) => point.residualM));
    const coverage = points.filter((point) => point.demHeightM !== null).length / points.length;
    if (residualRmse !== null && coverage >= 0.65 && residualRmse < bestRmse) {
      bestRmse = residualRmse;
      bestStepM = Math.round(step * 10) / 10;
    }
  }

  return bestStepM;
}

export function buildCheckpointTrajectory(input: BuildCheckpointTrajectoryInput): CheckpointTrajectoryResult {
  const startedAt = nowMs();
  const baroAltitudeM = input.baroAltitudeM ?? DEFAULT_MATCHER_CONFIG.baroAltitudeM;
  const sampleRateHz = input.sampleRateHz ?? DEFAULT_MATCHER_CONFIG.sampleRateHz;
  const sampleDistanceM = fitSampleDistanceM(input);
  const speedMps = sampleDistanceM * sampleRateHz;
  const points = buildPoints(
    input.heightsM,
    input.dem,
    input.startX,
    input.startY,
    input.azimuthDeg,
    sampleDistanceM,
    baroAltitudeM,
  );
  const profileRmseM = rmse(points.map((point) => point.residualM));
  const profileMaeM = mae(points.map((point) => point.residualM));
  const profileMaxErrorM = maxAbs(points.map((point) => point.residualM));
  const correlation = profileCorrelation(points);
  const coverageRatio = points.filter((point) => point.demHeightM !== null).length / points.length;
  const confidence = checkpointConfidence(profileRmseM, correlation, coverageRatio);
  const routeLengthM = Math.max(0, points.length - 1) * sampleDistanceM;

  let status: CheckpointTrajectoryResult["status"] = "TRAJECTORY READY";
  let statusReason = "Траектория построена по TXT-радиовысотам, стартовой точке, азимуту, скорости и частоте.";
  if (!input.dem || !input.dem.bbox) {
    status = "DEM UNAVAILABLE";
    statusReason = "GeoTIFF не загружен или без геопривязки: координаты построены, профиль с картой не сверен.";
  } else if (coverageRatio < 0.65 || (profileRmseM !== null && profileRmseM > 120) || confidence < 50) {
    status = "PROFILE MISMATCH";
    statusReason = "Профиль плохо совпадает с картой: проверьте старт X/Y, азимут, шаг или GeoTIFF.";
  }

  return {
    inputSamples: input.heightsM.length,
    baroAltitudeM,
    speedMps,
    sampleRateHz,
    sampleDistanceM,
    routeLengthM,
    azimuthDeg: input.azimuthDeg,
    startX: input.startX,
    startY: input.startY,
    points,
    profileRmseM,
    profileMaeM,
    profileMaxErrorM,
    profileCorrelation: correlation,
    coverageRatio,
    confidence,
    status,
    statusReason,
    demName: input.dem?.name ?? "GeoTIFF не загружен",
    crsLabel: input.dem?.crsLabel ?? "нет карты",
    computedAt: new Date().toISOString(),
    computeMs: Math.max(0, nowMs() - startedAt),
  };
}

export function checkpointResultToCsv(result: CheckpointTrajectoryResult): string {
  const header = [
    "index",
    "distance_m",
    "local_x",
    "local_y",
    "lat",
    "lon",
    "radio_altitude_m",
    "terrain_msl_from_radio_m",
    "height_dem_m",
    "residual_m",
  ];
  const rows = result.points.map((point) => [
    point.index,
    point.distanceM.toFixed(2),
    point.x.toFixed(2),
    point.y.toFixed(2),
    point.lat === null ? "" : point.lat.toFixed(8),
    point.lon === null ? "" : point.lon.toFixed(8),
    point.radioAltitudeM.toFixed(2),
    point.terrainMslM.toFixed(2),
    point.demHeightM === null ? "" : point.demHeightM.toFixed(2),
    point.residualM === null ? "" : point.residualM.toFixed(2),
  ]);

  return [header, ...rows].map((row) => row.join(",")).join("\n");
}

export function createTaigaCheckpointDem(): CheckpointDem {
  const metersPerDegreeLat = 111_320;
  const metersPerDegreeLon = metersPerDegreeLat * Math.cos(degToRad(TAIGA_ROUTE.start.lat));
  const localMinX = (COPERNICUS_TAIGA_DEM.bounds.lonMin - TAIGA_ROUTE.start.lon) * metersPerDegreeLon;
  const localMaxX = (COPERNICUS_TAIGA_DEM.bounds.lonMax - TAIGA_ROUTE.start.lon) * metersPerDegreeLon;
  const localMinY = (COPERNICUS_TAIGA_DEM.bounds.latMin - TAIGA_ROUTE.start.lat) * metersPerDegreeLat;
  const localMaxY = (COPERNICUS_TAIGA_DEM.bounds.latMax - TAIGA_ROUTE.start.lat) * metersPerDegreeLat;

  return {
    name: "Встроенный GeoTIFF map.tif",
    width: COPERNICUS_TAIGA_DEM.width,
    height: COPERNICUS_TAIGA_DEM.height,
    values: COPERNICUS_TAIGA_DEM.elevationM,
    minElevationM: COPERNICUS_TAIGA_DEM.minElevationM,
    maxElevationM: COPERNICUS_TAIGA_DEM.maxElevationM,
    noDataValue: null,
    bbox: {
      minX: localMinX,
      minY: localMinY,
      maxX: localMaxX,
      maxY: localMaxY,
    },
    coordinateMode: "taiga-local",
    crsLabel: "локальные метры map.tif + WGS-84",
  };
}

export function buildCheckpointDemoText(): string {
  const simulation = simulateFlight(DEFAULT_MATCHER_CONFIG);
  return simulation.samples.map((sample) => sample.radioAltitudeM.toFixed(2)).join("\n");
}

function finiteRasterValues(values: ArrayLike<number>, noDataValue: number | null): {
  values: number[];
  minElevationM: number;
  maxElevationM: number;
} {
  let minElevationM = Number.POSITIVE_INFINITY;
  let maxElevationM = Number.NEGATIVE_INFINITY;
  const clean = Array.from(values, (value) => {
    const numeric = Number(value);
    const isNoData = noDataValue !== null && Math.abs(numeric - noDataValue) < 1e-9;
    if (!Number.isFinite(numeric) || isNoData) return Number.NaN;
    minElevationM = Math.min(minElevationM, numeric);
    maxElevationM = Math.max(maxElevationM, numeric);
    return numeric;
  });

  if (!Number.isFinite(minElevationM) || !Number.isFinite(maxElevationM)) {
    throw new Error("GeoTIFF не содержит пригодный слой высот.");
  }

  return { values: clean, minElevationM, maxElevationM };
}

export async function loadCheckpointDemFromGeoTiff(file: File): Promise<CheckpointDem> {
  const tiff = await fromArrayBuffer(await file.arrayBuffer());
  const image = await tiff.getImage();
  const width = image.getWidth();
  const height = image.getHeight();
  const noDataValue = image.getGDALNoData();
  const raster = await image.readRasters({ samples: [0], interleave: true });
  const { values, minElevationM, maxElevationM } = finiteRasterValues(raster, noDataValue);
  const geoKeys = image.getGeoKeys();
  const geographicCode = geoKeys?.GeographicTypeGeoKey;
  const projectedCode = geoKeys?.ProjectedCSTypeGeoKey;
  let bbox: CheckpointDem["bbox"] = null;

  try {
    const [minX, minY, maxX, maxY] = image.getBoundingBox();
    bbox = { minX, minY, maxX, maxY };
  } catch {
    bbox = null;
  }

  const isWgs84 = geographicCode === 4326 && !projectedCode;
  const coordinateMode: CheckpointCoordinateMode = isWgs84 ? "wgs84" : projectedCode ? "projected" : "unknown";
  const crsLabel = isWgs84
    ? "WGS-84"
    : projectedCode
      ? `проекция EPSG:${projectedCode}`
      : geographicCode
        ? `географическая СК EPSG:${geographicCode}`
        : "геопривязка не распознана";

  return {
    name: file.name,
    width,
    height,
    values,
    minElevationM,
    maxElevationM,
    noDataValue,
    bbox,
    coordinateMode,
    crsLabel,
  };
}
