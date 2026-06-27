import { ChangeEvent, ReactNode, useCallback, useDeferredValue, useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Gauge,
  MapPinned,
  Monitor,
  Moon,
  Pause,
  Play,
  RotateCcw,
  Satellite,
  Settings,
  Signal,
  Sun,
} from "lucide-react";
import { FlightPreview3D, FlightReplayState } from "./FlightPreview3D";
import { COPERNICUS_TAIGA_DEM } from "./copernicusDemSample";
import {
  DEFAULT_MATCHER_CONFIG,
  MatchPoint,
  NavigationStatus,
  TAIGA_ROUTE,
  TerrainMatchResult,
  type AutopilotOutput,
  buildAutopilotOutputAtPoint,
  localPointToWgs84,
  routeLengthM,
  runTerrainMatching,
  solveFromNmea,
} from "./terrainMatcher";

type Config = typeof DEFAULT_MATCHER_CONFIG;
type ViewMode = "operator" | "method";
type InputMode = "simulation" | "nmea";
type MapViewMode = "height" | "satellite" | "hybrid";
type NmeaInputState = "empty" | "dirty" | "ready" | "error";
type ThemeMode = "light" | "dark" | "system";

const TILE_SIZE = 256;
const MAP_WIDTH = 980;
const MAP_HEIGHT = 560;
const HEIGHT_MAP_COLS = 98;
const HEIGHT_MAP_ROWS = 56;
const CONTOUR_STEP_M = 50;
const PX4_DEMO_NMEA_URL = "/examples/px4-derived-radio-altimeter.nmea";
const VANAVARA_CONTROL_NMEA_URL = "/examples/vanavara-success-radio-altimeter.nmea";
const REPLAY_SPEED_OPTIONS = [30, 60, 120, 240] as const;
const HEIGHT_COLOR_STOPS = [
  { t: 0, color: [19, 49, 31] },
  { t: 0.3, color: [53, 91, 43] },
  { t: 0.58, color: [119, 104, 50] },
  { t: 0.78, color: [168, 132, 78] },
  { t: 1, color: [231, 222, 190] },
] as const;

function formatNumber(value: number, digits = 0): string {
  return value.toLocaleString("ru-RU", {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  });
}

function formatMeters(value: number): string {
  if (Math.abs(value) >= 1000) return `${formatNumber(value / 1000, 1)} км`;
  return `${formatNumber(value, 0)} м`;
}

function formatCoord(value: number, axis: "lat" | "lon"): string {
  const hemi = axis === "lat" ? (value >= 0 ? "N" : "S") : value >= 0 ? "E" : "W";
  return `${Math.abs(value).toFixed(6)}° ${hemi}`;
}

function formatIsoDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("ru-RU");
}

function formatDuration(seconds: number): string {
  const safeSeconds = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(safeSeconds / 60);
  const remainder = safeSeconds % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function formatMetric(value: number | null, digits = 0, unit = ""): string {
  if (value === null || !Number.isFinite(value)) return "н/д";
  return `${formatNumber(value, digits)}${unit ? ` ${unit}` : ""}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function mixRgb(a: readonly number[], b: readonly number[], t: number): number[] {
  return [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];
}

function heightColor(elevationM: number, shade: number): string {
  const t = clamp(
    (elevationM - COPERNICUS_TAIGA_DEM.minElevationM) /
      Math.max(1, COPERNICUS_TAIGA_DEM.maxElevationM - COPERNICUS_TAIGA_DEM.minElevationM),
    0,
    1,
  );
  const upperIndex = Math.max(1, HEIGHT_COLOR_STOPS.findIndex((stop) => stop.t >= t));
  const lower = HEIGHT_COLOR_STOPS[upperIndex - 1];
  const upper = HEIGHT_COLOR_STOPS[upperIndex] ?? lower;
  const localT = (t - lower.t) / Math.max(0.001, upper.t - lower.t);
  const color = mixRgb(lower.color, upper.color, localT).map((channel) => Math.round(clamp(channel * shade, 0, 255)));
  return `rgb(${color[0]} ${color[1]} ${color[2]})`;
}

function statusClass(status: NavigationStatus): string {
  if (status === "FIX VALID") return "ok";
  if (status === "FIX DEGRADED" || status === "FIX AMBIGUOUS") return "warn";
  return "bad";
}

function statusLabel(status: NavigationStatus): string {
  switch (status) {
    case "FIX VALID":    return "РЕШЕНИЕ НАДЁЖНО";
    case "FIX DEGRADED": return "РЕШЕНИЕ СНИЖЕНО";
    case "FIX AMBIGUOUS": return "НЕОДНОЗНАЧНО";
    case "LOW RELIEF":   return "СЛАБЫЙ РЕЛЬЕФ";
    case "NO FIX":       return "НЕТ РЕШЕНИЯ";
  }
}

function eventLabel(code: string): string {
  switch (code) {
    case "RA_STREAM_STARTED":    return "Поток РВ запущен";
    case "PROFILE_WINDOW_READY": return "Окно профиля готово";
    case "SEARCH_STARTED":       return "Поиск запущен";
    case "BEST_CANDIDATE":       return "Кандидат найден";
    case "FIX_VALID":            return "Решение надёжно";
    case "FIX_DEGRADED":         return "Решение снижено";
    case "FIX_AMBIGUOUS":        return "Неоднозначно";
    case "LOW_RELIEF":           return "Слабый рельеф";
    case "NO_FIX":               return "Нет решения";
    default:                     return code;
  }
}

function buildCumulativeDistances(path: MatchPoint[]): number[] {
  let total = 0;
  return path.map((point, index) => {
    if (index > 0) {
      const previous = path[index - 1];
      total += Math.hypot(point.x - previous.x, point.y - previous.y);
    }
    return total;
  });
}

function Help({ text }: { text: string }) {
  return (
    <span className="help" tabIndex={0} aria-label={text}>
      ?
      <span>{text}</span>
    </span>
  );
}

function MiniButton({
  icon,
  label,
  active = false,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  active?: boolean;
  onClick: () => void;
}) {
  const caption = label.split(" ")[0];

  return (
    <button className={`mini-button${active ? " active" : ""}`} type="button" aria-label={label} onClick={onClick}>
      {icon}
      <span className="mini-button-caption">{caption}</span>
    </button>
  );
}

function InputRow({ label, value, help }: { label: string; value: string; help: string }) {
  return (
    <div className="input-row">
      <div>
        <span>{label}</span>
        <Help text={help} />
      </div>
      <strong>{value}</strong>
    </div>
  );
}

function ToggleRow({ label, enabled }: { label: string; enabled: boolean }) {
  return (
    <div className="toggle-row">
      <span>{label}</span>
      <i className={enabled ? "enabled" : ""}>{enabled ? "НОРМА" : "НЕТ"}</i>
    </div>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  unit,
  help,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  help: string;
  onChange: (value: number) => void;
}) {
  const decrease = () => onChange(Math.max(min, value - step));
  const increase = () => onChange(Math.min(max, value + step));

  return (
    <div className="slider">
      <div className="slider-head">
        <span>
          {label}
          <Help text={help} />
        </span>
        <div className="stepper">
          <button type="button" aria-label={`${label}: уменьшить`} onClick={decrease}>-</button>
          <strong>{formatNumber(value, 0)} {unit}</strong>
          <button type="button" aria-label={`${label}: увеличить`} onClick={increase}>+</button>
        </div>
      </div>
      <input
        aria-label={label}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
      />
    </div>
  );
}

function ModeSwitch({
  mode,
  onChange,
}: {
  mode: InputMode;
  onChange: (mode: InputMode) => void;
}) {
  return (
    <div className="mode-switch" role="group" aria-label="Режим входных данных">
      <button className={mode === "simulation" ? "active" : ""} type="button" onClick={() => onChange("simulation")}>
        Стенд
      </button>
      <button className={mode === "nmea" ? "active" : ""} type="button" onClick={() => onChange("nmea")}>
        Проверочный журнал
      </button>
    </div>
  );
}

function NmeaImportPanel({
  rawText,
  error,
  importedResult,
  isLoading,
  onTextChange,
  onFileChange,
  onAnalyze,
  onUseStandLog,
  onUseControlLog,
  onUsePx4Log,
}: {
  rawText: string;
  error: string | null;
  importedResult: TerrainMatchResult | null;
  isLoading: boolean;
  onTextChange: (value: string) => void;
  onFileChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onAnalyze: () => void;
  onUseStandLog: () => void;
  onUseControlLog: () => void;
  onUsePx4Log: () => void;
}) {
  const lineCount = rawText.split(/\r?\n/).filter(Boolean).length;
  const inputState: NmeaInputState = error ? "error" : importedResult ? "ready" : lineCount > 0 ? "dirty" : "empty";
  const stateLabel: Record<NmeaInputState, string> = {
    empty: "ожидает журнал",
    dirty: "журнал не рассчитан",
    ready: "расчёт готов",
    error: "ошибка",
  };
  const checksumLabel = importedResult
    ? importedResult.nmeaQuality.checksumInvalid > 0
      ? `ошибка ${importedResult.nmeaQuality.checksumInvalid}`
      : importedResult.nmeaQuality.checksumMissing > 0
        ? `нет ${importedResult.nmeaQuality.checksumMissing}`
        : "норма"
    : "нет расчёта";

  return (
    <div className="nmea-import">
      <label htmlFor="nmea-log">Проверочный журнал радиовысотомера</label>
      <textarea
        id="nmea-log"
        value={rawText}
        onChange={(event) => onTextChange(event.currentTarget.value)}
        spellCheck={false}
        placeholder="$GPGGA,123519.111,,,,,,,,545.4,M,46.9,M,,*7F"
      />
      <div className="nmea-import-actions">
        <label className="file-button" aria-disabled={isLoading}>
          Файл
          <input accept=".txt,.nmea,.log" type="file" onChange={onFileChange} disabled={isLoading} />
        </label>
        <button type="button" disabled={isLoading} onClick={onUseStandLog}>Пример стенда</button>
        <button type="button" disabled={isLoading} onClick={onUseControlLog}>{isLoading ? "Загрузка…" : "Контроль Ванавара"}</button>
        <button type="button" disabled={isLoading} onClick={onUsePx4Log}>{isLoading ? "Загрузка…" : "PX4 пример"}</button>
        <button className="primary" type="button" disabled={isLoading} onClick={onAnalyze}>Рассчитать по журналу</button>
      </div>
      <div className="nmea-import-state">
        <span>строк <b>{lineCount}</b></span>
        <span>режим <b>{stateLabel[inputState]}</b></span>
        <span>контрольная сумма <b>{checksumLabel}</b></span>
      </div>
      {error ? <p className="input-error">{error}</p> : null}
      {importedResult?.nmeaQuality.warning ? <p className="input-warning">{importedResult.nmeaQuality.warning}</p> : null}
    </div>
  );
}

function tileProject(lat: number, lon: number, zoom: number) {
  const scale = 2 ** zoom;
  const x = ((lon + 180) / 360) * scale;
  const latRad = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * scale;
  return { x, y };
}

function tileToLatLon(x: number, y: number, zoom: number) {
  const scale = 2 ** zoom;
  const lon = (x / scale) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * y) / scale;
  const lat = (Math.atan(Math.sinh(n)) * 180) / Math.PI;
  return { lat, lon };
}

function mapPixelToWgs84(x: number, y: number, center: { x: number; y: number }, zoom: number) {
  return tileToLatLon(
    center.x + (x - MAP_WIDTH / 2) / TILE_SIZE,
    center.y + (y - MAP_HEIGHT / 2) / TILE_SIZE,
    zoom,
  );
}

function sampleDemAtLatLon(lat: number, lon: number): number | null {
  const { bounds, width, height, elevationM } = COPERNICUS_TAIGA_DEM;
  if (lat < bounds.latMin || lat > bounds.latMax || lon < bounds.lonMin || lon > bounds.lonMax) {
    return null;
  }

  const px = ((lon - bounds.lonMin) / (bounds.lonMax - bounds.lonMin)) * (width - 1);
  const py = ((bounds.latMax - lat) / (bounds.latMax - bounds.latMin)) * (height - 1);
  const x0 = clamp(Math.floor(px), 0, width - 1);
  const y0 = clamp(Math.floor(py), 0, height - 1);
  const x1 = clamp(x0 + 1, 0, width - 1);
  const y1 = clamp(y0 + 1, 0, height - 1);
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

type HeightMapCell = {
  key: string;
  row: number;
  col: number;
  x: number;
  y: number;
  width: number;
  height: number;
  elevationM: number | null;
  fill: string;
};

function buildHeightMapCells(center: { x: number; y: number }, zoom: number): HeightMapCell[] {
  const cells: HeightMapCell[] = [];
  const cellW = MAP_WIDTH / HEIGHT_MAP_COLS;
  const cellH = MAP_HEIGHT / HEIGHT_MAP_ROWS;

  for (let row = 0; row < HEIGHT_MAP_ROWS; row += 1) {
    for (let col = 0; col < HEIGHT_MAP_COLS; col += 1) {
      const x = col * cellW;
      const y = row * cellH;
      const { lat, lon } = mapPixelToWgs84(x + cellW / 2, y + cellH / 2, center, zoom);
      const elevationM = sampleDemAtLatLon(lat, lon);
      let fill = "#07100d";

      if (elevationM !== null) {
        const north = sampleDemAtLatLon(lat + 0.003, lon) ?? elevationM;
        const south = sampleDemAtLatLon(lat - 0.003, lon) ?? elevationM;
        const east = sampleDemAtLatLon(lat, lon + 0.003) ?? elevationM;
        const west = sampleDemAtLatLon(lat, lon - 0.003) ?? elevationM;
        const shade = clamp(0.78 + (west - east) * 0.018 + (south - north) * 0.014, 0.48, 1.2);
        fill = heightColor(elevationM, shade);
      }

      cells.push({ key: `${row}-${col}`, row, col, x, y, width: cellW + 0.25, height: cellH + 0.25, elevationM, fill });
    }
  }

  return cells;
}

function buildContourPath(cells: HeightMapCell[]): string {
  const byGrid = new Map(cells.map((cell) => [`${cell.row}-${cell.col}`, cell]));
  const segments: string[] = [];

  for (const cell of cells) {
    if (cell.elevationM === null) continue;
    const band = Math.floor(cell.elevationM / CONTOUR_STEP_M);
    const left = byGrid.get(`${cell.row}-${cell.col - 1}`);
    const top = byGrid.get(`${cell.row - 1}-${cell.col}`);

    if (left?.elevationM !== null && left?.elevationM !== undefined && Math.floor(left.elevationM / CONTOUR_STEP_M) !== band) {
      segments.push(`M ${cell.x.toFixed(1)} ${cell.y.toFixed(1)} L ${cell.x.toFixed(1)} ${(cell.y + cell.height).toFixed(1)}`);
    }

    if (top?.elevationM !== null && top?.elevationM !== undefined && Math.floor(top.elevationM / CONTOUR_STEP_M) !== band) {
      segments.push(`M ${cell.x.toFixed(1)} ${cell.y.toFixed(1)} L ${(cell.x + cell.width).toFixed(1)} ${cell.y.toFixed(1)}`);
    }
  }

  return segments.join(" ");
}

function pathToLatLon(path: MatchPoint[]) {
  return path.map((point) => ({ ...localPointToWgs84(point), t: point.t }));
}

function buildRoutePath(path: MatchPoint[], center: { x: number; y: number }, zoom: number) {
  const wgs = pathToLatLon(path);
  const step = Math.max(1, Math.floor(wgs.length / 260));
  return wgs
    .filter((_, index) => index % step === 0 || index === wgs.length - 1)
    .map((point, index) => {
      const projected = tileProject(point.lat, point.lon, zoom);
      const x = (projected.x - center.x) * TILE_SIZE + MAP_WIDTH / 2;
      const y = (projected.y - center.y) * TILE_SIZE + MAP_HEIGHT / 2;
      return `${index === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
}

function pointOnMap(point: MatchPoint, center: { x: number; y: number }, zoom: number) {
  const wgs = localPointToWgs84(point);
  const projected = tileProject(wgs.lat, wgs.lon, zoom);
  return {
    x: (projected.x - center.x) * TILE_SIZE + MAP_WIDTH / 2,
    y: (projected.y - center.y) * TILE_SIZE + MAP_HEIGHT / 2,
  };
}

function MapViewSwitch({ value, onChange }: { value: MapViewMode; onChange: (value: MapViewMode) => void }) {
  return (
    <div className="map-view-switch" role="group" aria-label="Вид карты">
      <button className={value === "height" ? "active" : ""} type="button" onClick={() => onChange("height")}>
        Карта высот
      </button>
      <button className={value === "satellite" ? "active" : ""} type="button" onClick={() => onChange("satellite")}>
        Спутниковая подложка
      </button>
      <button className={value === "hybrid" ? "active" : ""} type="button" onClick={() => onChange("hybrid")}>
        Совмещённо
      </button>
    </div>
  );
}

function SatelliteMap({
  result,
  currentPoint,
  mapView,
  onMapViewChange,
}: {
  result: TerrainMatchResult;
  currentPoint: MatchPoint;
  mapView: MapViewMode;
  onMapViewChange: (value: MapViewMode) => void;
}) {
  const zoom = 9;
  const basePath = result.truthAvailable && result.truthPath.length > 1 ? result.truthPath : result.estimatedPath;
  const start = basePath[0];
  const finish = basePath[basePath.length - 1];
  const startWgs = localPointToWgs84(start);
  const finishWgs = localPointToWgs84(finish);
  const centerWgs = {
    lat: (startWgs.lat + finishWgs.lat) / 2,
    lon: (startWgs.lon + finishWgs.lon) / 2,
  };
  const centerTile = tileProject(centerWgs.lat, centerWgs.lon, zoom);
  const tileMinX = Math.floor(centerTile.x - MAP_WIDTH / TILE_SIZE / 2) - 1;
  const tileMaxX = Math.ceil(centerTile.x + MAP_WIDTH / TILE_SIZE / 2) + 1;
  const tileMinY = Math.floor(centerTile.y - MAP_HEIGHT / TILE_SIZE / 2) - 1;
  const tileMaxY = Math.ceil(centerTile.y + MAP_HEIGHT / TILE_SIZE / 2) + 1;
  const tiles = [];

  for (let x = tileMinX; x <= tileMaxX; x += 1) {
    for (let y = tileMinY; y <= tileMaxY; y += 1) {
      tiles.push({
        key: `${x}-${y}`,
        href: `https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${zoom}/${y}/${x}`,
        x: (x - centerTile.x) * TILE_SIZE + MAP_WIDTH / 2,
        y: (y - centerTile.y) * TILE_SIZE + MAP_HEIGHT / 2,
      });
    }
  }

  const truthD = result.truthAvailable ? buildRoutePath(result.truthPath, centerTile, zoom) : "";
  const estimateD = buildRoutePath(result.estimatedPath, centerTile, zoom);
  const startPoint = pointOnMap(start, centerTile, zoom);
  const finishPoint = pointOnMap(finish, centerTile, zoom);
  const currentMapPoint = pointOnMap(currentPoint, centerTile, zoom);
  const heightCells = useMemo(() => buildHeightMapCells(centerTile, zoom), [centerTile.x, centerTile.y, zoom]);
  const contourD = useMemo(() => buildContourPath(heightCells), [heightCells]);
  const legendTicks = [0, 0.25, 0.5, 0.75, 1].map((t) =>
    Math.round(mix(COPERNICUS_TAIGA_DEM.minElevationM, COPERNICUS_TAIGA_DEM.maxElevationM, t)),
  );
  const satelliteOpacity = mapView === "satellite" ? 1 : mapView === "hybrid" ? 0.34 : 0;
  const heightOpacity = mapView === "height" ? 1 : mapView === "hybrid" ? 0.9 : 0;
  const metersPerPixel = (156543.03392 * Math.cos((centerWgs.lat * Math.PI) / 180)) / 2 ** zoom;
  const scaleLineMeters = 25_000;
  const scaleLinePx = scaleLineMeters / Math.max(1, metersPerPixel);

  return (
    <section className="map-shell">
      <div className="map-head">
        <div>
          <span>Карта высот + траектория</span>
          <h2>{TAIGA_ROUTE.routeName}</h2>
        </div>
        <div className="map-head-tools">
          <MapViewSwitch value={mapView} onChange={onMapViewChange} />
          <div className="map-legend">
            {result.truthAvailable ? <span><i className="route-real" /> истинная траектория</span> : null}
            <span><i className="route-found" /> оценка алгоритма</span>
          </div>
        </div>
      </div>
      <svg className="satellite-map" viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`} role="img" aria-label="Карта высот с найденной траекторией">
        <defs>
          <filter id="routeBlur">
            <feGaussianBlur stdDeviation="3" />
          </filter>
          <linearGradient id="mapShade" x1="0" x2="1" y1="0" y2="1">
            <stop offset="0%" stopColor="#061117" stopOpacity="0.2" />
            <stop offset="100%" stopColor="#2dd4bf" stopOpacity="0.12" />
          </linearGradient>
          <linearGradient id="heightLegendGradient" x1="0" x2="1" y1="0" y2="0">
            {HEIGHT_COLOR_STOPS.map((stop) => (
              <stop
                key={stop.t}
                offset={`${stop.t * 100}%`}
                stopColor={`rgb(${stop.color[0]} ${stop.color[1]} ${stop.color[2]})`}
              />
            ))}
          </linearGradient>
        </defs>
        <rect width={MAP_WIDTH} height={MAP_HEIGHT} fill="#17251b" />
        {mapView !== "height" ? (
          <g opacity={satelliteOpacity}>
            {tiles.map((tile) => (
              <image
                key={tile.key}
                href={tile.href}
                x={tile.x}
                y={tile.y}
                width={TILE_SIZE}
                height={TILE_SIZE}
                preserveAspectRatio="none"
              />
            ))}
            <rect width={MAP_WIDTH} height={MAP_HEIGHT} fill="rgba(3, 13, 18, 0.22)" />
          </g>
        ) : null}
        {mapView !== "satellite" ? (
          <g className="height-map-layer" opacity={heightOpacity}>
            {heightCells.map((cell) => (
              <rect key={cell.key} x={cell.x} y={cell.y} width={cell.width} height={cell.height} fill={cell.fill} />
            ))}
            <path d={contourD} className="height-contours" />
          </g>
        ) : null}
        <rect width={MAP_WIDTH} height={MAP_HEIGHT} fill="url(#mapShade)" />
        {result.truthAvailable ? <path d={truthD} className="route-shadow" filter="url(#routeBlur)" /> : null}
        {result.truthAvailable ? <path d={truthD} className="route-real-path" /> : null}
        <path d={estimateD} className="route-found-path" />
        <rect x={startPoint.x - 8} y={startPoint.y - 8} width="16" height="16" className="map-dot start" />
        <rect x={finishPoint.x - 10} y={finishPoint.y - 10} width="20" height="20" className="map-dot finish" />
        <circle cx={currentMapPoint.x} cy={currentMapPoint.y} r="11" className="map-current-pulse" />
        <circle cx={currentMapPoint.x} cy={currentMapPoint.y} r="6" className="map-current-dot" />
        <text x={startPoint.x + 14} y={startPoint.y - 12} className="map-label">{result.truthAvailable ? TAIGA_ROUTE.startName : "старт оценки"}</text>
        <text x={finishPoint.x + 15} y={finishPoint.y + 5} className="map-label">{result.truthAvailable ? TAIGA_ROUTE.finishName : "оценка"}</text>
        <text x={currentMapPoint.x + 13} y={currentMapPoint.y - 11} className="map-label">текущая оценка</text>
        <text x={currentMapPoint.x + 13} y={currentMapPoint.y + 9} className="map-coordinate-label">
          X {formatNumber(currentPoint.x, 0)} м · Y {formatNumber(currentPoint.y, 0)} м
        </text>
        <text x="32" y={MAP_HEIGHT - 38} className="map-scale">0     12,5     25 км</text>
        <line x1="34" y1={MAP_HEIGHT - 25} x2={34 + scaleLinePx} y2={MAP_HEIGHT - 25} className="scale-line" />
        <g className="height-legend-box" transform={`translate(${MAP_WIDTH - 292} ${MAP_HEIGHT - 82})`}>
          <rect width="260" height="54" rx="6" />
          <text x="14" y="18">высота земли, м</text>
          <rect x="14" y="26" width="214" height="8" fill="url(#heightLegendGradient)" />
          {legendTicks.map((tick, index) => (
            <text key={tick} x={14 + index * (214 / 4)} y="47" textAnchor={index === 0 ? "start" : index === 4 ? "end" : "middle"}>
              {tick}
            </text>
          ))}
        </g>
      </svg>
      <div className="map-foot">
        <span>{TAIGA_ROUTE.region}</span>
        <span>{TAIGA_ROUTE.demName}</span>
        <span>диапазон высот {formatNumber(COPERNICUS_TAIGA_DEM.minElevationM, 0)}-{formatNumber(COPERNICUS_TAIGA_DEM.maxElevationM, 0)} м</span>
      </div>
    </section>
  );
}

function StatusStrip({ result }: { result: TerrainMatchResult }) {
  return (
    <section className="status-strip">
      <div>
        <span>Статус</span>
        <strong className={statusClass(result.navigationStatus)}>{statusLabel(result.navigationStatus)}</strong>
      </div>
      <div>
        <span>вход</span>
        <strong>РВ + ЦМР</strong>
      </div>
      <div>
        <span>Совпадение</span>
        <strong>{result.best.correlation.toFixed(3)}</strong>
      </div>
      <div>
        <span>Ошибка профиля</span>
        <strong>{formatMeters(result.best.rmseM)}</strong>
      </div>
      <div>
        <span>достоверность</span>
        <strong>{result.best.confidence}%</strong>
      </div>
    </section>
  );
}

function SolutionPanel({
  result,
  currentPoint,
  currentDistanceM,
  currentElapsedS,
  currentAglM,
}: {
  result: TerrainMatchResult;
  currentPoint: MatchPoint;
  currentDistanceM: number;
  currentElapsedS: number;
  currentAglM: number;
}) {
  const currentWgs = localPointToWgs84(currentPoint);
  const confidence = result.best.confidence;

  return (
    <aside className="solution-card">
      <div className="solution-top">
        <span>Оценка положения · T+ {formatDuration(currentElapsedS)}</span>
        <strong className={statusClass(result.navigationStatus)}>{statusLabel(result.navigationStatus)}</strong>
        <p>{result.statusReason}</p>
      </div>
      <div className="coordinates">
        <b>{formatCoord(currentWgs.lat, "lat")}</b>
        <b>{formatCoord(currentWgs.lon, "lon")}</b>
      </div>
      <div className="local-coordinates">
        <span>Локальные координаты карты высот</span>
        <div>
          <b>X {formatNumber(currentPoint.x, 0)} м</b>
          <b>Y {formatNumber(currentPoint.y, 0)} м</b>
        </div>
      </div>
      <div className="decision-grid">
        <div>
          <span>Путевая скорость</span>
          <strong>{formatNumber(result.best.speedMps, 1)} м/с</strong>
        </div>
        <div>
          <span>Азимут</span>
          <strong>{formatNumber(result.best.azimuthDeg, 0)}°</strong>
        </div>
        <div>
          <span>Высота над землёй</span>
          <strong>{formatMeters(currentAglM)}</strong>
        </div>
        <div>
          <span>Пройдено</span>
          <strong>{formatMeters(currentDistanceM)}</strong>
        </div>
      </div>
      <div className="confidence">
        <div>
          <span>Достоверность</span>
          <strong>{confidence}%</strong>
        </div>
        <i><em style={{ width: `${confidence}%` }} /></i>
      </div>
    </aside>
  );
}

function CorrelationSurface({ result }: { result: TerrainMatchResult }) {
  const width = 560;
  const height = 230;
  const speeds = Array.from(new Set(result.heatmap.map((cell) => cell.speedMps))).sort((a, b) => a - b);
  const speedIndex = new Map(speeds.map((speed, index) => [speed, index]));
  const minCorr = Math.min(...result.heatmap.map((cell) => cell.correlation));
  const maxCorr = Math.max(...result.heatmap.map((cell) => cell.correlation));
  const cellW = width / 360;
  const cellH = height / speeds.length;
  const bestY = height - ((speedIndex.get(result.best.speedMps) ?? 0) + 0.5) * cellH;

  return (
    <section className="panel correlation-panel">
      <header>
        <div>
          <span>Тепловая карта совпадений</span>
          <h3>Азимут и скорость</h3>
        </div>
        <strong>{result.best.correlation.toFixed(3)}</strong>
      </header>
      <svg viewBox={`0 0 ${width} ${height}`} className="heatmap" role="img" aria-label="Тепловая карта совпадений по направлению и скорости">
        {result.heatmap.map((cell) => {
          const t = (cell.correlation - minCorr) / Math.max(0.001, maxCorr - minCorr);
          const x = cell.azimuthDeg * cellW;
          const y = height - ((speedIndex.get(cell.speedMps) ?? 0) + 1) * cellH;
          return (
            <rect
              key={`${cell.azimuthDeg}-${cell.speedMps}`}
              x={x}
              y={y}
              width={Math.max(1.2, cellW + 0.2)}
              height={Math.max(2, cellH + 0.2)}
              fill={`rgba(${Math.round(19 + t * 240)}, ${Math.round(34 + t * 194)}, ${Math.round(72 + t * 80)}, ${0.32 + t * 0.66})`}
            />
          );
        })}
        {[0, 90, 180, 270].map((azimuth) => (
          <text key={azimuth} x={azimuth * cellW + 5} y="20" className="axis-label">{azimuth}°</text>
        ))}
        <rect x={result.best.azimuthDeg * cellW - 8} y={bestY - 8} width="17" height="17" className="best-dot" />
        <text x={result.best.azimuthDeg * cellW + 18} y={bestY - 9} className="axis-label">
          {result.best.azimuthDeg}° · {formatNumber(result.best.speedMps, 0)} м/с
        </text>
      </svg>
    </section>
  );
}

function TerrainProfile({ result }: { result: TerrainMatchResult }) {
  const width = 900;
  const height = 240;
  const step = Math.max(1, Math.floor(result.measuredProfile.length / 260));
  const points = result.measuredProfile
    .map((value, index) => ({ measured: value, reference: result.referenceProfile[index], index }))
    .filter((_, index) => index % step === 0);
  const min = Math.min(...points.map((point) => Math.min(point.measured, point.reference)));
  const max = Math.max(...points.map((point) => Math.max(point.measured, point.reference)));

  function path(key: "measured" | "reference") {
    return points
      .map((point, index) => {
        const x = (index / Math.max(1, points.length - 1)) * width;
        const y = height - ((point[key] - min) / Math.max(1, max - min)) * height;
        return `${index === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
      })
      .join(" ");
  }

  return (
    <section className="panel profile-panel">
      <header>
        <div>
          <span>Профиль рельефа</span>
          <h3>Высоты вдоль трассы</h3>
        </div>
        <div className="chart-legend">
          <span><i className="measured" /> измерено РВ</span>
          <span><i className="reference" /> эталон карты</span>
        </div>
      </header>
      <svg viewBox={`0 0 ${width} ${height}`} className="profile-chart" role="img" aria-label="Профиль рельефа">
        {Array.from({ length: 5 }, (_, index) => (
          <line key={index} x1="0" x2={width} y1={(index + 1) * (height / 6)} y2={(index + 1) * (height / 6)} />
        ))}
        <path d={path("reference")} className="reference-path" />
        <path d={path("measured")} className="measured-path" />
      </svg>
    </section>
  );
}

function NmeaStream({ result, currentIndex }: { result: TerrainMatchResult; currentIndex: number }) {
  const end = Math.min(result.nmea.length, Math.max(1, currentIndex + 1));
  const rows = result.nmea.slice(Math.max(0, end - 10), end).reverse();

  return (
    <section className="panel nmea-panel">
      <header>
        <div>
          <span>Проверочный журнал</span>
          <h3>Поток радиовысотомера</h3>
        </div>
        <strong>№{end}</strong>
      </header>
      <div className="nmea-table">
        {rows.map((row, index) => (
          <code key={`${row}-${index}`}>{row}</code>
        ))}
      </div>
    </section>
  );
}

function ValidationPanel({ result }: { result: TerrainMatchResult }) {
  return (
    <section className="panel facts-panel">
      <header>
        <div>
          <span>Валидация</span>
          <h3>Метрики</h3>
        </div>
        <CheckCircle2 size={22} />
      </header>
      <div className="fact-list">
        <div><Gauge size={17} /><span>Пик корреляции: <b>{result.best.correlation.toFixed(3)}</b></span></div>
        <div><Gauge size={17} /><span>Второй пик: <b>{result.secondCorrelation?.toFixed(3) ?? "н/д"}</b></span></div>
        <div><Activity size={17} /><span>Разрыв пиков: <b>{result.ambiguity.toFixed(3)}</b></span></div>
        <div><Activity size={17} /><span>Ошибка профиля: <b>{formatMeters(result.best.rmseM)}</b></span></div>
        <div><Clock3 size={17} /><span>Время расчёта: <b>{formatNumber(result.computeMs, 0)} мс</b></span></div>
        <div><Gauge size={17} /><span>Достоверность: <b>{result.best.confidence}%</b></span></div>
        <div><AlertTriangle size={17} /><span>Изменчивость рельефа: <b>{formatMetric(result.terrainStdM, 1, "м")}</b></span></div>
        <div><AlertTriangle size={17} /><span>Контрольная сумма НМЕА: <b>{result.nmeaQuality.checksumInvalid > 0 ? `${result.nmeaQuality.checksumInvalid} ошибок` : "норма"}</b></span></div>
        {result.truthAvailable ? (
          <>
            <div><Activity size={17} /><span>Ошибка скорости: <b>{formatMetric(result.speedErrorMps, 1, "м/с")}</b></span></div>
            <div><Activity size={17} /><span>Ошибка азимута: <b>{formatMetric(result.azimuthErrorDeg, 0, "°")}</b></span></div>
            <div><MapPinned size={17} /><span>Ошибка финальная: <b>{formatMetric(result.finalErrorM, 0, "м")}</b></span></div>
            <div><MapPinned size={17} /><span>Ошибка средняя: <b>{formatMetric(result.meanErrorM, 0, "м")}</b></span></div>
          </>
        ) : (
          <div><AlertTriangle size={17} /><span>Эталон: <b>не приложен</b></span></div>
        )}
      </div>
    </section>
  );
}

function AlgorithmOutputPanel({ result, output }: { result: TerrainMatchResult; output: AutopilotOutput }) {
  return (
    <section className="panel autopilot-panel">
      <header>
        <div>
          <span>Выход алгоритма</span>
          <h3>Результат расчёта</h3>
        </div>
        <Signal size={22} />
      </header>
      <div className="output-grid">
        <div>
          <span>X локальный</span>
          <b>{formatNumber(output.localXM, 0)} м</b>
        </div>
        <div>
          <span>Y локальный</span>
          <b>{formatNumber(output.localYM, 0)} м</b>
        </div>
        <div>
          <span>Широта</span>
          <b>{formatCoord(output.lat, "lat")}</b>
        </div>
        <div>
          <span>Долгота</span>
          <b>{formatCoord(output.lon, "lon")}</b>
        </div>
        <div>
          <span>Путевая скорость</span>
          <b>{formatNumber(output.groundSpeedMps, 1)} м/с</b>
        </div>
        <div>
          <span>Азимут</span>
          <b>{formatNumber(output.azimuthDeg, 0)}°</b>
        </div>
        <div>
          <span>Достоверность</span>
          <b>{formatNumber(output.confidence, 2)}</b>
        </div>
        <div>
          <span>Совпадение профилей</span>
          <b>{result.best.correlation.toFixed(3)}</b>
        </div>
        <div>
          <span>Ошибка профиля</span>
          <b>{formatMeters(result.best.rmseM)}</b>
        </div>
        <div>
          <span>Время расчёта</span>
          <b>{formatNumber(result.computeMs, 0)} мс</b>
        </div>
        <div>
          <span>Статус</span>
          <b>{statusLabel(output.navigationStatus)}</b>
        </div>
        <div>
          <span>Неопределённость</span>
          <b>{output.uncertaintyM === null ? "н/д" : `${formatNumber(output.uncertaintyM, 0)} м`}</b>
        </div>
        <div>
          <span>Контрольная сумма</span>
          <b>{result.nmeaQuality.checksumInvalid > 0 ? `ошибка ${result.nmeaQuality.checksumInvalid}` : "норма"}</b>
        </div>
        <div className="wide">
          <span>Основа расчёта</span>
          <b>РВ + 1500 м + ЦМР</b>
        </div>
      </div>
    </section>
  );
}

function AlgorithmEventLog({ result }: { result: TerrainMatchResult }) {
  return (
    <section className="panel event-panel">
      <header>
        <div>
          <span>События алгоритма</span>
          <h3>Трасса расчёта</h3>
        </div>
        <Activity size={22} />
      </header>
      <div className="event-log">
        {result.events.map((event) => (
          <div key={`${event.code}-${event.elapsedMs}`}>
            <code>{eventLabel(event.code)}</code>
            <span>{event.elapsedMs} мс</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function MethodologyMode() {
  return (
    <section className="methodology">
      <article>
        <h2>Методика</h2>
        <p>Этот режим нужен для защиты и трекеров. Основной экран остаётся операторской панелью.</p>
      </article>
      <article>
        <strong>1. Радиовысотомер</strong>
        <span>Радиовысотомер измеряет расстояние от борта до поверхности.</span>
      </article>
      <article>
        <strong>2. Высота 1500 м</strong>
        <span>В кейсе высота борта над уровнем моря постоянная: 1500 м MSL.</span>
      </article>
      <article>
        <strong>3. Профиль</strong>
        <span>Высота земли = 1500 м − Радиовысотомер. Так получается профиль рельефа вдоль трассы.</span>
      </article>
      <article>
        <strong>4. Корреляция</strong>
        <span>Система перебирает азимут 0-359° и скорость, затем ищет максимум совпадения.</span>
      </article>
      <article>
        <strong>5. Проверочный журнал</strong>
        <span>Внешний NMEA загружается в этот же контур: расчётная часть получает только РВ, высоту 1500 м и карту высот Copernicus GLO-30.</span>
      </article>
      <article>
        <strong>6. 3D-реконструкция</strong>
        <span>Превью не управляет расчётом: оно показывает текущую найденную траекторию, скорость и высоту над землёй из результата алгоритма.</span>
      </article>
      <article>
        <strong>7. Шум РВ</strong>
        <span>Стенд позволяет менять шум радиовысотомера и смотреть, как меняются corr, СКО, доверие и статус.</span>
      </article>
    </section>
  );
}

function NmeaAwaitingState({ rawText, error }: { rawText: string; error: string | null }) {
  const lineCount = rawText.split(/\r?\n/).filter(Boolean).length;
  return (
    <section className="panel nmea-empty-panel">
      <header>
        <div>
          <span>Проверочный журнал</span>
          <h3>{error ? "Расчёт отклонён" : "Оценка не рассчитана"}</h3>
        </div>
        <AlertTriangle size={22} />
      </header>
      <div className="nmea-empty-grid">
        <div>
          <span>строк журнала</span>
          <b>{lineCount}</b>
        </div>
        <div>
          <span>статус</span>
          <b>{error ? "ошибка" : lineCount > 0 ? "ожидает расчёт" : "нет входа"}</b>
        </div>
      </div>
      <p>{error ?? "Вставьте или загрузите NMEA-журнал радиовысотомера и запустите расчёт. До этого координата не выдаётся."}</p>
    </section>
  );
}

function NoNavigationOutputPanel({ rawText, error }: { rawText: string; error: string | null }) {
  const lineCount = rawText.split(/\r?\n/).filter(Boolean).length;
  return (
    <section className="panel autopilot-panel no-output-panel">
      <header>
        <div>
          <span>Выход алгоритма</span>
          <h3>Данные не готовы</h3>
        </div>
        <Signal size={22} />
      </header>
      <div className="output-grid">
        <div>
          <span>Строк NMEA</span>
          <b>{lineCount}</b>
        </div>
        <div>
          <span>Состояние</span>
          <b>{error ? "ошибка" : "не рассчитано"}</b>
        </div>
        <div className="wide">
          <span>Причина</span>
          <b>{error ?? "эталон недоступен · координата не рассчитана"}</b>
        </div>
      </div>
    </section>
  );
}

function ThemeToggle({ theme, onChange }: { theme: ThemeMode; onChange: (t: ThemeMode) => void }) {
  return (
    <div className="theme-switcher" role="group" aria-label="Тема оформления">
      <button type="button" className={theme === "light" ? "active" : ""} aria-label="Белая тема" onClick={() => onChange("light")}>
        <Sun size={15} />
      </button>
      <button type="button" className={theme === "dark" ? "active" : ""} aria-label="Тёмная тема" onClick={() => onChange("dark")}>
        <Moon size={15} />
      </button>
      <button type="button" className={theme === "system" ? "active" : ""} aria-label="Как система" onClick={() => onChange("system")}>
        <Monitor size={15} />
      </button>
    </div>
  );
}

export function App() {
  const [theme, setTheme] = useState<ThemeMode>(() => {
    return (localStorage.getItem("theme") as ThemeMode | null) ?? "dark";
  });

  useEffect(() => {
    const root = document.documentElement;
    const resolved = theme === "system"
      ? (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark")
      : theme;
    root.setAttribute("data-theme", resolved);
    localStorage.setItem("theme", theme);
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const handler = (e: MediaQueryListEvent) => root.setAttribute("data-theme", e.matches ? "light" : "dark");
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [theme]);

  const [config, setConfig] = useState<Config>(DEFAULT_MATCHER_CONFIG);
  const [mode, setMode] = useState<ViewMode>("operator");
  const [inputMode, setInputMode] = useState<InputMode>("simulation");
  const [mapView, setMapView] = useState<MapViewMode>("height");
  const [rawNmeaText, setRawNmeaText] = useState("");
  const [importedResult, setImportedResult] = useState<TerrainMatchResult | null>(null);
  const [nmeaError, setNmeaError] = useState<string | null>(null);
  const [isLoadingNmea, setLoadingNmea] = useState(false);
  const [replayState, setReplayState] = useState<FlightReplayState | null>(null);
  const [isReplayPaused, setReplayPaused] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [replaySpeedMultiplier, setReplaySpeedMultiplier] = useState(120);
  // Defer heavy terrain matching computation so slider thumb updates immediately.
  const deferredConfig = useDeferredValue(config);
  const simulationResult = useMemo(() => runTerrainMatching(deferredConfig), [deferredConfig]);
  const result = inputMode === "nmea" ? importedResult : simulationResult;
  const routeKm = result ? routeLengthM(result.truthAvailable ? result.truthPath : result.estimatedPath) / 1000 : 0;
  const cumulativeEstimateDistances = useMemo(() => result ? buildCumulativeDistances(result.estimatedPath) : [], [result]);
  const currentIndex = result
    ? Math.min(
      Math.max(0, replayState?.pointIndex ?? 0),
      Math.max(0, result.estimatedPath.length - 1),
    )
    : 0;
  const currentPoint = result?.estimatedPath[currentIndex] ?? null;
  const currentElapsedS = currentPoint?.t ?? replayState?.elapsedS ?? 0;
  const currentAglM =
    replayState?.aglM ??
    result?.samples[currentIndex]?.radioAltitudeM ??
    (currentPoint && result ? result.config.baroAltitudeM - currentPoint.elevationM : 0);
  const currentDistanceM = cumulativeEstimateDistances[currentIndex] ?? 0;
  const currentAutopilotOutput = useMemo(
    () =>
      result && currentPoint
        ? buildAutopilotOutputAtPoint(
          currentPoint,
          result.best,
          result.navigationStatus,
          result.terrainStdM,
          result.ambiguity,
          result.config,
        )
        : null,
    [currentPoint, result],
  );
  const handleReplayChange = useCallback((state: FlightReplayState) => {
    setReplayState((current) => {
      if (
        current &&
        current.pointIndex === state.pointIndex &&
        Math.abs(current.aglM - state.aglM) < 0.5
      ) {
        return current;
      }
      return state;
    });
  }, []);

  useEffect(() => {
    setReplayState(null);
  }, [result]);

  function updateConfig<K extends keyof Config>(key: K, value: Config[K]) {
    setConfig((current) => ({ ...current, [key]: value }));
  }

  function reset() {
    setConfig(DEFAULT_MATCHER_CONFIG);
    setImportedResult(null);
    setNmeaError(null);
    setRawNmeaText("");
  }

  function handleInputModeChange(nextMode: InputMode) {
    setInputMode(nextMode);
    setReplayState(null);
  }

  function handleNmeaTextChange(value: string) {
    setRawNmeaText(value);
    setImportedResult(null);
    setNmeaError(null);
    setInputMode("nmea");
  }

  async function loadNmeaFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    if (!file) return;
    const text = await file.text();
    setRawNmeaText(text);
    setImportedResult(null);
    setNmeaError(null);
    setInputMode("nmea");
  }

  function useStandLog() {
    const text = simulationResult.nmea.join("\n");
    setRawNmeaText(text);
    solveNmeaText(text);
  }

  function solveNmeaText(text: string) {
    setInputMode("nmea");
    setImportedResult(null);
    try {
      const solved = solveFromNmea(text, {
        terrainKind: config.terrainKind,
        baroAltitudeM: config.baroAltitudeM,
        sampleRateHz: config.sampleRateHz,
        speedMinMps: config.speedMinMps,
        speedMaxMps: config.speedMaxMps,
        speedStepMps: config.speedStepMps,
        plannedAzimuthDeg: config.plannedAzimuthDeg,
        courseLookaheadM: config.courseLookaheadM,
      });
      setImportedResult(solved);
      setNmeaError(null);
    } catch (error) {
      setImportedResult(null);
      setNmeaError(error instanceof Error ? error.message : "Не удалось разобрать журнал NMEA.");
    }
  }

  function analyzeNmeaLog() {
    solveNmeaText(rawNmeaText);
  }

  async function useControlLog() {
    setInputMode("nmea");
    setImportedResult(null);
    setNmeaError(null);
    setLoadingNmea(true);
    try {
      const response = await fetch(VANAVARA_CONTROL_NMEA_URL, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      setRawNmeaText(text);
      solveNmeaText(text);
    } catch {
      setImportedResult(null);
      setNmeaError("Не удалось загрузить контрольный журнал Ванавары из examples.");
    } finally {
      setLoadingNmea(false);
    }
  }

  async function usePx4Log() {
    setInputMode("nmea");
    setImportedResult(null);
    setNmeaError(null);
    setLoadingNmea(true);
    try {
      const response = await fetch(PX4_DEMO_NMEA_URL, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      setRawNmeaText(text);
      solveNmeaText(text);
    } catch {
      setImportedResult(null);
      setNmeaError("Не удалось загрузить PX4 пример из examples.");
    } finally {
      setLoadingNmea(false);
    }
  }

  return (
    <div className="ops-shell">
      <header className="ops-topbar">
        <div className="brand-block">
          <div className="brand-icon"><MapPinned size={24} /></div>
          <strong className="brand-name">КРОТ</strong>
        </div>
        <div className="top-status"><Signal size={15} /> РВ + 1500 М + ЦМР / КОРРЕЛЯЦИОННЫЙ ПОИСК</div>
        <div className="top-actions">
          <button className={mode === "operator" ? "active" : ""} type="button" onClick={() => setMode("operator")}>Оператор</button>
          <button className={mode === "method" ? "active" : ""} type="button" onClick={() => setMode("method")}>Методика</button>
          <ThemeToggle theme={theme} onChange={setTheme} />
          <MiniButton
            icon={isReplayPaused ? <Play size={17} /> : <Pause size={17} />}
            label={isReplayPaused ? "Продолжить прокрутку" : "Пауза"}
            active={isReplayPaused}
            onClick={() => setReplayPaused((value) => !value)}
          />
          <MiniButton
            icon={<Settings size={17} />}
            label="Настройки симуляции"
            active={settingsOpen}
            onClick={() => setSettingsOpen((value) => !value)}
          />
          {settingsOpen ? (
            <div className="settings-popover" role="dialog" aria-label="Настройки симуляции">
              <div className="settings-popover-head">
                <span>Скорость прокрутки</span>
                <strong>x{replaySpeedMultiplier}</strong>
              </div>
              <input
                aria-label="Скорость прокрутки"
                type="range"
                min={10}
                max={240}
                step={10}
                value={replaySpeedMultiplier}
                onChange={(event) => setReplaySpeedMultiplier(Number(event.currentTarget.value))}
              />
              <div className="speed-buttons" role="group" aria-label="Быстрый выбор скорости">
                {REPLAY_SPEED_OPTIONS.map((speed) => (
                  <button
                    key={speed}
                    className={replaySpeedMultiplier === speed ? "active" : ""}
                    type="button"
                    onClick={() => setReplaySpeedMultiplier(speed)}
                  >
                    x{speed}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </header>

      <main className="ops-grid">
        <aside className="left-rail">
          <section className="rail-panel">
            <h2>Входные данные</h2>
            <InputRow
              label="Карта высот"
              value={TAIGA_ROUTE.demName}
              help="Таблица высот земли по району. В рабочем контуре заменяется на Copernicus GLO-30, SRTM или ALOS."
            />
            <InputRow
              label="Высота MSL"
              value={`${formatNumber(config.baroAltitudeM, 0)} м`}
              help="Постоянная абсолютная высота борта над уровнем моря. В кейсе задано 1500 м."
            />
            <InputRow
              label="Радиовысотомер"
              value={`NMEA · ${config.sampleRateHz} Гц`}
              help="Радиовысотомер: расстояние от борта до поверхности. Формат входа — NMEA-0183."
            />
            <InputRow
              label="Диапазон скорости"
              value={`${config.speedMinMps}-${config.speedMaxMps} м/с`}
              help="Диапазон перебора путевой скорости."
            />
          </section>

          <section className="rail-panel">
            <div className="rail-title">
              <h2>Режим входа</h2>
              <button type="button" onClick={reset} aria-label="Сбросить вводные"><RotateCcw size={16} /></button>
            </div>
            <ModeSwitch mode={inputMode} onChange={handleInputModeChange} />
            {inputMode === "simulation" ? (
              <>
                <Slider
                  label="Скорость"
                  value={config.trueSpeedMps}
                  min={35}
                  max={65}
                  step={1}
                  unit="м/с"
                  help="Параметр стенда. Итоговая Vпут справа — результат перебора алгоритма."
                  onChange={(value) => updateConfig("trueSpeedMps", value)}
                />
                <Slider
                  label="Азимут"
                  value={config.trueAzimuthDeg}
                  min={0}
                  max={359}
                  step={1}
                  unit="°"
                  help="Параметр стенда. Итоговый азимут справа — найденный максимум совпадения."
                  onChange={(value) => updateConfig("trueAzimuthDeg", value)}
                />
                <Slider
                  label="Окно"
                  value={config.durationS}
                  min={1200}
                  max={5400}
                  step={300}
                  unit="с"
                  help="Длительность участка корреляции."
                  onChange={(value) => updateConfig("durationS", value)}
                />
                <Slider
                  label="Шум РВ"
                  value={config.radioNoiseM}
                  min={0}
                  max={12}
                  step={1}
                  unit="м"
                  help="Шум радиовысотомера в метрах."
                  onChange={(value) => updateConfig("radioNoiseM", value)}
                />
              </>
            ) : (
              <NmeaImportPanel
                rawText={rawNmeaText}
                error={nmeaError}
                importedResult={importedResult}
                isLoading={isLoadingNmea}
                onTextChange={handleNmeaTextChange}
                onFileChange={loadNmeaFile}
                onAnalyze={analyzeNmeaLog}
                onUseStandLog={useStandLog}
                onUseControlLog={useControlLog}
                onUsePx4Log={usePx4Log}
              />
            )}
          </section>

          <section className="rail-panel">
            <h2>Состояние системы</h2>
            <ToggleRow label="H=1500" enabled />
            <ToggleRow label="РВ" enabled />
            <ToggleRow label="КАРТА ВЫСОТ" enabled />
            <ToggleRow label="КОНТУР" enabled />
          </section>
        </aside>

        <section className="center-stage">
          {mode === "operator" ? (
            result && currentPoint ? (
              <>
                <StatusStrip result={result} />
                <FlightPreview3D
                  result={result}
                  replayState={replayState}
                  replaySpeedMultiplier={replaySpeedMultiplier}
                  isReplayPaused={isReplayPaused}
                  onReplayChange={handleReplayChange}
                  theme={theme}
                />
                <SatelliteMap result={result} currentPoint={currentPoint} mapView={mapView} onMapViewChange={setMapView} />
                <div className="bottom-grid">
                  <NmeaStream result={result} currentIndex={currentIndex} />
                  <TerrainProfile result={result} />
                </div>
              </>
            ) : (
              <NmeaAwaitingState rawText={rawNmeaText} error={nmeaError} />
            )
          ) : (
            <MethodologyMode />
          )}
        </section>

        <aside className="right-rail">
          {result && currentPoint ? (
            <>
              <SolutionPanel
                result={result}
                currentPoint={currentPoint}
                currentDistanceM={currentDistanceM}
                currentElapsedS={currentElapsedS}
                currentAglM={currentAglM}
              />
              {currentAutopilotOutput ? <AlgorithmOutputPanel result={result} output={currentAutopilotOutput} /> : null}
              <ValidationPanel result={result} />
              <AlgorithmEventLog result={result} />
              <CorrelationSurface result={result} />
              <section className="panel region-panel">
                <header>
                  <div>
                    <span>Район</span>
                    <h3>{TAIGA_ROUTE.region}</h3>
                  </div>
                  <Satellite size={22} />
                </header>
                <p>{TAIGA_ROUTE.note}</p>
                <div className="region-stats">
                  <span>трасса <b>{formatNumber(routeKm, 1)} км</b></span>
                  <span>река <b>{TAIGA_ROUTE.riverName}</b></span>
                </div>
                <div className="dem-provenance">
                  <span>Карта высот</span>
                  <b>{COPERNICUS_TAIGA_DEM.sourceName}</b>
                  <small>
                    {COPERNICUS_TAIGA_DEM.width}x{COPERNICUS_TAIGA_DEM.height} · {COPERNICUS_TAIGA_DEM.bounds.latMin.toFixed(2)}-{COPERNICUS_TAIGA_DEM.bounds.latMax.toFixed(2)} N · {COPERNICUS_TAIGA_DEM.bounds.lonMin.toFixed(2)}-{COPERNICUS_TAIGA_DEM.bounds.lonMax.toFixed(2)} E · {formatIsoDate(COPERNICUS_TAIGA_DEM.generatedAt)}
                  </small>
                </div>
              </section>
            </>
          ) : (
            <NoNavigationOutputPanel rawText={rawNmeaText} error={nmeaError} />
          )}
        </aside>
      </main>
    </div>
  );
}

export default App;
