import { ChangeEvent, ReactNode, useCallback, useDeferredValue, useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock3,
  GalleryVerticalEnd,
  Gauge,
  Mountain,
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
  buildCheckpointDemoText,
  buildCheckpointTrajectory,
  checkpointResultToCsv,
  createTaigaCheckpointDem,
  loadCheckpointDemFromGeoTiff,
  parseCheckpointHeights,
  sampleCheckpointDem,
  type CheckpointDem,
  type CheckpointTrajectoryResult,
} from "./checkpoint3";
import {
  DEFAULT_MATCHER_CONFIG,
  FLAT_DEMO_CONFIG,
  MatchPoint,
  MOUNTAIN_DEMO_CONFIG,
  NavigationStatus,
  TAIGA_ROUTE,
  TerrainMatchResult,
  type AutopilotOutput,
  buildAutopilotOutputAtPoint,
  localPointToWgs84,
  routeLengthM,
  runTerrainMatching,
  solveFromNmea,
  terrainElevationMsl,
} from "./terrainMatcher";

type Config = typeof DEFAULT_MATCHER_CONFIG;
type InputMode = "simulation" | "nmea" | "checkpoint";
type ScenarioId = "taiga" | "mountain" | "flat" | "bad-log";
type NmeaInputState = "empty" | "dirty" | "ready" | "error";
type ThemeMode = "light" | "dark" | "system";
type CheckpointForm = {
  startX: number;
  startY: number;
  azimuthDeg: number;
  sampleDistanceM: number;
  autoFitStep: boolean;
  stepMinM: number;
  stepMaxM: number;
};

const MAP_WIDTH = 980;
const MAP_HEIGHT = 560;
const MAP_RASTER_WIDTH = 980;
const MAP_RASTER_HEIGHT = 560;
const CONTOUR_GRID_COLS = 184;
const CONTOUR_GRID_ROWS = 106;
const PX4_DEMO_NMEA_URL = "/examples/px4-derived-radio-altimeter.nmea";
const VANAVARA_CONTROL_NMEA_URL = "/examples/vanavara-success-radio-altimeter.nmea";
const REPLAY_SPEED_OPTIONS = [30, 60, 120, 240] as const;

const SCENARIO_CONFIGS: Record<Exclude<ScenarioId, "bad-log">, Config> = {
  taiga: DEFAULT_MATCHER_CONFIG,
  mountain: MOUNTAIN_DEMO_CONFIG,
  flat: FLAT_DEMO_CONFIG,
};

const SCENARIO_META: Record<ScenarioId, {
  label: string;
  shortLabel: string;
  description: string;
  mapTitle: string;
  region: string;
  source: string;
}> = {
  taiga: {
    label: "Тайга / Ванавара",
    shortLabel: "Тайга",
    description: "Основной реальный сэмпл карты высот Copernicus GLO-30.",
    mapTitle: TAIGA_ROUTE.routeName,
    region: TAIGA_ROUTE.region,
    source: TAIGA_ROUTE.demName,
  },
  mountain: {
    label: "Горный рельеф",
    shortLabel: "Горы",
    description: "Контрольный горный рельеф для проверки выраженных перепадов.",
    mapTitle: "Контрольный горный рельеф",
    region: "контрольный синтетический рельеф, не данные заказчика",
    source: "контрольная карта высот / горный рельеф",
  },
  flat: {
    label: "Равнина / озеро",
    shortLabel: "Равнина",
    description: "Слабый рельеф: доверие должно падать, координата не должна быть уверенной.",
    mapTitle: "Равнина / озеро",
    region: "контрольный слабый рельеф, не данные заказчика",
    source: "контрольная карта высот / равнина и озеро",
  },
  "bad-log": {
    label: "Несовместимый журнал",
    shortLabel: "Отказ",
    description: "Внешний журнал не соответствует текущей карте высот: ожидается отказ.",
    mapTitle: "Несовместимый журнал",
    region: "проверка отказа от ложной координаты",
    source: "PX4-derived журнал + карта высот Ванавары",
  },
};

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

function statusClass(status: NavigationStatus): string {
  if (status === "FIX VALID") return "ok";
  if (status === "FIX DEGRADED" || status === "FIX AMBIGUOUS") return "warn";
  return "bad";
}

function statusLabel(status: NavigationStatus): string {
  switch (status) {
    case "FIX VALID":    return "МЕСТО НАЙДЕНО";
    case "FIX DEGRADED": return "ПРИВЯЗКА НЕТОЧНАЯ";
    case "FIX AMBIGUOUS": return "НЕСКОЛЬКО ВАРИАНТОВ";
    case "LOW RELIEF":   return "СЛАБЫЙ РЕЛЬЕФ";
    case "NO FIX":       return "МЕСТО НЕ НАЙДЕНО";
  }
}

function eventLabel(code: string): string {
  switch (code) {
    case "RA_STREAM_STARTED":    return "Поток РВ запущен";
    case "PROFILE_WINDOW_READY": return "Окно профиля готово";
    case "SEARCH_STARTED":       return "Поиск запущен";
    case "BEST_CANDIDATE":       return "Кандидат найден";
    case "FIX_VALID":            return "Место найдено";
    case "FIX_DEGRADED":         return "Привязка неточная";
    case "FIX_AMBIGUOUS":        return "Несколько вариантов";
    case "LOW_RELIEF":           return "Слабый рельеф";
    case "NO_FIX":               return "Место не найдено";
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
  const compact = caption.length <= 6;

  return (
    <button className={`${compact ? "mini-button" : "action-button"}${active ? " active" : ""}`} type="button" aria-label={label} onClick={onClick}>
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
      <button className={mode === "checkpoint" ? "active" : ""} type="button" onClick={() => onChange("checkpoint")}>
        Чекпоинт 3
      </button>
    </div>
  );
}

function scenarioIcon(id: ScenarioId): ReactNode {
  if (id === "mountain") return <Mountain size={18} />;
  if (id === "flat") return <GalleryVerticalEnd size={18} />;
  if (id === "bad-log") return <AlertTriangle size={18} />;
  return <MapPinned size={18} />;
}

function scenarioKicker(id: ScenarioId): string {
  if (id === "taiga") return "DEM GLO-30";
  if (id === "mountain") return "контроль";
  if (id === "flat") return "слабый рельеф";
  return "отказ";
}

function ScenarioPanel({
  activeScenario,
  isLoading,
  onSelect,
}: {
  activeScenario: ScenarioId;
  isLoading: boolean;
  onSelect: (scenario: ScenarioId) => void;
}) {
  const scenarios: ScenarioId[] = ["taiga", "mountain", "flat", "bad-log"];
  const activeMeta = SCENARIO_META[activeScenario];

  return (
    <section className="scenario-switcher">
      <div className="scenario-switcher-head">
        <div>
          <span>Сценарии проверки</span>
          <strong>{activeMeta.label}</strong>
        </div>
        <p>{scenarioKicker(activeScenario)} · {activeMeta.source}</p>
      </div>
      <div className="scenario-grid" role="group" aria-label="Сценарии проверки">
        {scenarios.map((scenario) => {
          const meta = SCENARIO_META[scenario];
          return (
            <button
              key={scenario}
              data-scenario={scenario}
              className={activeScenario === scenario ? "active" : ""}
              type="button"
              disabled={isLoading}
              onClick={() => onSelect(scenario)}
            >
              <i>{scenarioIcon(scenario)}</i>
              <span>{meta.shortLabel}</span>
              <small>{scenarioKicker(scenario)}</small>
            </button>
          );
        })}
      </div>
    </section>
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

function FieldNumber({
  label,
  value,
  step = 1,
  onChange,
}: {
  label: string;
  value: number;
  step?: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="checkpoint-field">
      <span>{label}</span>
      <input
        type="number"
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
      />
    </label>
  );
}

function CheckpointImportPanel({
  rawText,
  form,
  dem,
  result,
  error,
  isLoadingDem,
  onTextChange,
  onHeightsFileChange,
  onGeoTiffChange,
  onFormChange,
  onAnalyze,
  onUseDemo,
  onExportCsv,
}: {
  rawText: string;
  form: CheckpointForm;
  dem: CheckpointDem | null;
  result: CheckpointTrajectoryResult | null;
  error: string | null;
  isLoadingDem: boolean;
  onTextChange: (value: string) => void;
  onHeightsFileChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onGeoTiffChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onFormChange: (patch: Partial<CheckpointForm>) => void;
  onAnalyze: () => void;
  onUseDemo: () => void;
  onExportCsv: () => void;
}) {
  const lineCount = rawText.split(/\r?\n/).filter((row) => row.trim()).length;

  return (
    <div className="checkpoint-import">
      <label htmlFor="checkpoint-heights">Высоты TXT, м</label>
      <textarea
        id="checkpoint-heights"
        value={rawText}
        onChange={(event) => onTextChange(event.currentTarget.value)}
        spellCheck={false}
        placeholder={"312.4\n313.1\n314.0"}
      />
      <div className="checkpoint-form-grid">
        <FieldNumber label="Старт X" value={form.startX} onChange={(value) => onFormChange({ startX: value })} />
        <FieldNumber label="Старт Y" value={form.startY} onChange={(value) => onFormChange({ startY: value })} />
        <FieldNumber label="Азимут, °" value={form.azimuthDeg} onChange={(value) => onFormChange({ azimuthDeg: value })} />
        <FieldNumber label="Шаг, м" value={form.sampleDistanceM} step={0.5} onChange={(value) => onFormChange({ sampleDistanceM: value })} />
        <FieldNumber label="Мин. шаг" value={form.stepMinM} step={0.5} onChange={(value) => onFormChange({ stepMinM: value })} />
        <FieldNumber label="Макс. шаг" value={form.stepMaxM} step={0.5} onChange={(value) => onFormChange({ stepMaxM: value })} />
      </div>
      <label className="checkpoint-check">
        <input
          type="checkbox"
          checked={form.autoFitStep}
          onChange={(event) => onFormChange({ autoFitStep: event.currentTarget.checked })}
        />
        <span>Автоподбор шага по GeoTIFF</span>
      </label>
      <div className="nmea-import-actions">
        <label className="file-button">
          TXT
          <input accept=".txt,.csv,.log" type="file" onChange={onHeightsFileChange} />
        </label>
        <label className="file-button" aria-disabled={isLoadingDem}>
          {isLoadingDem ? "Чтение…" : "GeoTIFF"}
          <input accept=".tif,.tiff,.geotiff" type="file" onChange={onGeoTiffChange} disabled={isLoadingDem} />
        </label>
        <button type="button" onClick={onUseDemo}>Пример TXT</button>
        <button className="primary" type="button" onClick={onAnalyze}>Рассчитать траекторию</button>
        <button type="button" disabled={!result} onClick={onExportCsv}>CSV</button>
      </div>
      <div className="nmea-import-state">
        <span>строк <b>{lineCount}</b></span>
        <span>карта <b>{dem ? `${dem.width}x${dem.height}` : "нет"}</b></span>
        <span>СК <b>{dem?.crsLabel ?? "нет"}</b></span>
      </div>
      {error ? <p className="input-error">{error}</p> : null}
    </div>
  );
}

type MapBounds = {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
};

type ElevationContour = {
  key: string;
  d: string;
  emphasis: boolean;
};

type ElevationLayer = {
  rasterDataUrl: string | null;
  contours: ElevationContour[];
  minElevationM: number;
  maxElevationM: number;
};

type ElevationSampler = (localX: number, localY: number) => number | null;

function terrainRgb(value: number, min: number, max: number): [number, number, number] {
  const t = clamp((value - min) / Math.max(1, max - min), 0, 1);
  const stops = [
    { t: 0, rgb: [28, 64, 128] },
    { t: 0.22, rgb: [43, 140, 118] },
    { t: 0.48, rgb: [92, 146, 57] },
    { t: 0.68, rgb: [201, 183, 73] },
    { t: 0.86, rgb: [196, 112, 72] },
    { t: 1, rgb: [232, 210, 174] },
  ];
  const nextIndex = Math.max(1, stops.findIndex((stop) => t <= stop.t));
  const a = stops[nextIndex - 1];
  const b = stops[nextIndex];
  const localT = (t - a.t) / Math.max(0.001, b.t - a.t);
  return a.rgb.map((channel, index) => Math.round(channel + (b.rgb[index] - channel) * localT)) as [number, number, number];
}

function terrainColor(value: number, min: number, max: number) {
  const rgb = terrainRgb(value, min, max);
  return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
}

function buildMapBounds(path: MatchPoint[]): MapBounds {
  const xs = path.map((point) => point.x);
  const ys = path.map((point) => point.y);
  let minX = Math.min(...xs);
  let maxX = Math.max(...xs);
  let minY = Math.min(...ys);
  let maxY = Math.max(...ys);
  const width = Math.max(1, maxX - minX);
  const height = Math.max(1, maxY - minY);
  const padding = Math.max(width, height) * 0.18;
  minX -= padding;
  maxX += padding;
  minY -= padding;
  maxY += padding;

  const targetAspect = MAP_WIDTH / MAP_HEIGHT;
  const currentAspect = (maxX - minX) / Math.max(1, maxY - minY);
  if (currentAspect > targetAspect) {
    const neededHeight = (maxX - minX) / targetAspect;
    const centerY = (minY + maxY) / 2;
    minY = centerY - neededHeight / 2;
    maxY = centerY + neededHeight / 2;
  } else {
    const neededWidth = (maxY - minY) * targetAspect;
    const centerX = (minX + maxX) / 2;
    minX = centerX - neededWidth / 2;
    maxX = centerX + neededWidth / 2;
  }

  return { minX, maxX, minY, maxY };
}

function copernicusDemLocalBounds(): MapBounds {
  const metersPerDegreeLat = 111_320;
  const metersPerDegreeLon = metersPerDegreeLat * Math.cos((TAIGA_ROUTE.start.lat * Math.PI) / 180);
  const { bounds } = COPERNICUS_TAIGA_DEM;

  return {
    minX: (bounds.lonMin - TAIGA_ROUTE.start.lon) * metersPerDegreeLon,
    maxX: (bounds.lonMax - TAIGA_ROUTE.start.lon) * metersPerDegreeLon,
    minY: (bounds.latMin - TAIGA_ROUTE.start.lat) * metersPerDegreeLat,
    maxY: (bounds.latMax - TAIGA_ROUTE.start.lat) * metersPerDegreeLat,
  };
}

function localToMap(point: Pick<MatchPoint, "x" | "y">, bounds: MapBounds) {
  return {
    x: ((point.x - bounds.minX) / Math.max(1, bounds.maxX - bounds.minX)) * MAP_WIDTH,
    y: MAP_HEIGHT - ((point.y - bounds.minY) / Math.max(1, bounds.maxY - bounds.minY)) * MAP_HEIGHT,
  };
}

function buildTerrainRasterDataUrl(
  sampler: ElevationSampler,
  bounds: MapBounds,
  width = MAP_RASTER_WIDTH,
  height = MAP_RASTER_HEIGHT,
): { dataUrl: string | null; minElevationM: number; maxElevationM: number } {
  const elevations = new Float32Array(width * height);
  const valid = new Uint8Array(width * height);
  let minElevationM = Number.POSITIVE_INFINITY;
  let maxElevationM = Number.NEGATIVE_INFINITY;

  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      const localX = bounds.minX + ((col + 0.5) / width) * (bounds.maxX - bounds.minX);
      const localY = bounds.minY + ((height - row - 0.5) / height) * (bounds.maxY - bounds.minY);
      const elevationM = sampler(localX, localY);
      const index = row * width + col;
      if (elevationM === null || !Number.isFinite(elevationM)) continue;
      elevations[index] = elevationM;
      valid[index] = 1;
      minElevationM = Math.min(minElevationM, elevationM);
      maxElevationM = Math.max(maxElevationM, elevationM);
    }
  }

  if (!Number.isFinite(minElevationM) || !Number.isFinite(maxElevationM)) {
    return { dataUrl: null, minElevationM: 0, maxElevationM: 0 };
  }

  if (typeof document === "undefined") {
    return { dataUrl: null, minElevationM, maxElevationM };
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) return { dataUrl: null, minElevationM, maxElevationM };

  const imageData = context.createImageData(width, height);
  const shadeRadius = 5;
  const elevationAt = (row: number, col: number, fallback: number) => {
    const safeRow = clamp(row, 0, height - 1);
    const safeCol = clamp(col, 0, width - 1);
    const index = safeRow * width + safeCol;
    return valid[index] ? elevations[index] : fallback;
  };

  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      const index = row * width + col;
      const pixel = index * 4;
      if (!valid[index]) {
        imageData.data[pixel] = 12;
        imageData.data[pixel + 1] = 18;
        imageData.data[pixel + 2] = 18;
        imageData.data[pixel + 3] = 255;
        continue;
      }

      const elevationM = elevations[index];
      const [baseR, baseG, baseB] = terrainRgb(elevationM, minElevationM, maxElevationM);
      const west = elevationAt(row, col - shadeRadius, elevationM);
      const east = elevationAt(row, col + shadeRadius, elevationM);
      const north = elevationAt(row - shadeRadius, col, elevationM);
      const south = elevationAt(row + shadeRadius, col, elevationM);
      const diagonal = elevationAt(row - shadeRadius, col - shadeRadius, elevationM) - elevationAt(row + shadeRadius, col + shadeRadius, elevationM);
      const slope = (west - east) * 0.014 + (south - north) * 0.018 + diagonal * 0.008;
      const shade = clamp(0.82 + slope, 0.48, 1.26);
      const relief = clamp((Math.abs(west - east) + Math.abs(south - north)) * 0.012, 0, 0.16);

      imageData.data[pixel] = clamp(Math.round(baseR * shade + 255 * relief), 0, 255);
      imageData.data[pixel + 1] = clamp(Math.round(baseG * shade + 244 * relief), 0, 255);
      imageData.data[pixel + 2] = clamp(Math.round(baseB * shade + 220 * relief), 0, 255);
      imageData.data[pixel + 3] = 255;
    }
  }

  context.putImageData(imageData, 0, 0);
  return { dataUrl: canvas.toDataURL("image/png"), minElevationM, maxElevationM };
}

function buildElevationContours(
  sampler: ElevationSampler,
  bounds: MapBounds,
  minElevationM: number,
  maxElevationM: number,
): ElevationContour[] {
  const contourCount = 7;
  const contourStep = (maxElevationM - minElevationM) / contourCount;
  const contours: ElevationContour[] = [];
  if (contourStep <= 0) return contours;

  const cols = CONTOUR_GRID_COLS;
  const rows = CONTOUR_GRID_ROWS;
  const values = new Float32Array(cols * rows);
  const xStep = MAP_WIDTH / (cols - 1);
  const yStep = MAP_HEIGHT / (rows - 1);

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const localX = bounds.minX + (col / (cols - 1)) * (bounds.maxX - bounds.minX);
      const localY = bounds.minY + ((rows - row - 1) / (rows - 1)) * (bounds.maxY - bounds.minY);
      values[row * cols + col] = sampler(localX, localY) ?? minElevationM;
    }
  }

  const valueAt = (row: number, col: number) => values[row * cols + col];
  const interpolate = (level: number, a: number, b: number, ax: number, ay: number, bx: number, by: number) => {
    const t = clamp((level - a) / Math.max(0.0001, b - a), 0, 1);
    return {
      x: ax + (bx - ax) * t,
      y: ay + (by - ay) * t,
    };
  };

  for (let levelIndex = 1; levelIndex < contourCount; levelIndex += 1) {
    const level = minElevationM + contourStep * levelIndex;
    const segments: string[] = [];
    for (let row = 0; row < rows - 1; row += 1) {
      for (let col = 0; col < cols - 1; col += 1) {
        const v00 = valueAt(row, col);
        const v10 = valueAt(row, col + 1);
        const v11 = valueAt(row + 1, col + 1);
        const v01 = valueAt(row + 1, col);
        const x0 = col * xStep;
        const x1 = (col + 1) * xStep;
        const y0 = row * yStep;
        const y1 = (row + 1) * yStep;
        const points: { x: number; y: number }[] = [];

        if ((v00 <= level && v10 > level) || (v00 > level && v10 <= level)) {
          points.push(interpolate(level, v00, v10, x0, y0, x1, y0));
        }
        if ((v10 <= level && v11 > level) || (v10 > level && v11 <= level)) {
          points.push(interpolate(level, v10, v11, x1, y0, x1, y1));
        }
        if ((v01 <= level && v11 > level) || (v01 > level && v11 <= level)) {
          points.push(interpolate(level, v01, v11, x0, y1, x1, y1));
        }
        if ((v00 <= level && v01 > level) || (v00 > level && v01 <= level)) {
          points.push(interpolate(level, v00, v01, x0, y0, x0, y1));
        }

        if (points.length >= 2) {
          segments.push(`M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)} L ${points[1].x.toFixed(1)} ${points[1].y.toFixed(1)}`);
        }
        if (points.length === 4) {
          segments.push(`M ${points[2].x.toFixed(1)} ${points[2].y.toFixed(1)} L ${points[3].x.toFixed(1)} ${points[3].y.toFixed(1)}`);
        }
      }
    }
    contours.push({
      key: `contour-${levelIndex}`,
      d: segments.join(" "),
      emphasis: levelIndex === Math.floor(contourCount / 2),
    });
  }

  return contours;
}

function buildElevationLayer(sampler: ElevationSampler, bounds: MapBounds): ElevationLayer {
  const raster = buildTerrainRasterDataUrl(sampler, bounds);
  const contours = raster.dataUrl
    ? buildElevationContours(sampler, bounds, raster.minElevationM, raster.maxElevationM)
    : [];

  return {
    rasterDataUrl: raster.dataUrl,
    contours,
    minElevationM: raster.minElevationM,
    maxElevationM: raster.maxElevationM,
  };
}

function pointWithDisplayCurve(path: MatchPoint[], point: MatchPoint, index: number, amplitudeM: number): MatchPoint {
  if (path.length < 2 || amplitudeM <= 0) return point;
  const start = path[0];
  const finish = path[path.length - 1];
  const dx = finish.x - start.x;
  const dy = finish.y - start.y;
  const length = Math.hypot(dx, dy);
  if (length < 1) return point;

  const progress = clamp(index / Math.max(1, path.length - 1), 0, 1);
  const taper = Math.sin(Math.PI * progress);
  const offset =
    taper *
    (Math.sin(progress * Math.PI * 4.6 + 0.45) * amplitudeM +
      Math.sin(progress * Math.PI * 11.2) * amplitudeM * 0.28);
  const normalX = -dy / length;
  const normalY = dx / length;

  return {
    ...point,
    x: point.x + normalX * offset,
    y: point.y + normalY * offset,
  };
}

function buildRoutePath(path: MatchPoint[], bounds: MapBounds, amplitudeM = 0) {
  const step = Math.max(1, Math.floor(path.length / 260));
  return path
    .map((point, index) => ({ point, index }))
    .filter(({ index }) => index % step === 0 || index === path.length - 1)
    .map(({ point, index }, renderIndex) => {
      const displayPoint = pointWithDisplayCurve(path, point, index, amplitudeM);
      const projected = localToMap(displayPoint, bounds);
      return `${renderIndex === 0 ? "M" : "L"} ${projected.x.toFixed(1)} ${projected.y.toFixed(1)}`;
    })
    .join(" ");
}

function pointOnMap(point: MatchPoint, bounds: MapBounds) {
  return localToMap(point, bounds);
}

function SatelliteMap({
  result,
  currentPoint,
  scenario,
}: {
  result: TerrainMatchResult;
  currentPoint: MatchPoint;
  scenario: ScenarioId;
}) {
  const scenarioMeta = SCENARIO_META[scenario];
  const basePath = result.truthAvailable && result.truthPath.length > 1 ? result.truthPath : result.estimatedPath;
  const { bounds, elevation } = useMemo(() => {
    const mapPath = result.truthAvailable && result.truthPath.length > 1
      ? [...result.truthPath, ...result.estimatedPath]
      : result.estimatedPath;
    const nextBounds = result.config.terrainKind === "taiga"
      ? copernicusDemLocalBounds()
      : buildMapBounds(mapPath);
    return {
      bounds: nextBounds,
      elevation: buildElevationLayer(
        (localX, localY) => terrainElevationMsl(result.config.terrainKind, localX, localY),
        nextBounds,
      ),
    };
  }, [result]);
  const start = basePath[0];
  const finish = basePath[basePath.length - 1];
  const truthD = result.truthAvailable ? buildRoutePath(result.truthPath, bounds, 3600) : "";
  const estimateD = buildRoutePath(result.estimatedPath, bounds);
  const startPoint = pointOnMap(start, bounds);
  const finishPoint = pointOnMap(finish, bounds);
  const currentMapPoint = pointOnMap(currentPoint, bounds);

  return (
    <section className="map-shell">
      <div className="map-head">
        <div>
          <span>Карта высот + траектория</span>
          <h2>{scenarioMeta.mapTitle}</h2>
        </div>
        <div className="map-legend">
          <span><i className="elevation-low" /> низины</span>
          <span><i className="elevation-high" /> высоты</span>
          {result.truthAvailable ? <span><i className="route-real" /> стендовая траектория</span> : null}
          <span><i className="route-found" /> оценка алгоритма</span>
        </div>
      </div>
      <svg className="satellite-map elevation-map" viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`} role="img" aria-label="Карта высот с найденной траекторией">
        <defs>
          <filter id="routeBlur">
            <feGaussianBlur stdDeviation="3" />
          </filter>
          <filter id="terrainSmooth">
            <feGaussianBlur stdDeviation="1.25" />
          </filter>
          <linearGradient id="heightLegendGradient" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0%" stopColor={terrainColor(elevation.minElevationM, elevation.minElevationM, elevation.maxElevationM)} />
            <stop offset="35%" stopColor={terrainColor((elevation.minElevationM + elevation.maxElevationM) / 2, elevation.minElevationM, elevation.maxElevationM)} />
            <stop offset="100%" stopColor={terrainColor(elevation.maxElevationM, elevation.minElevationM, elevation.maxElevationM)} />
          </linearGradient>
          <linearGradient id="elevationShade" x1="0" x2="1" y1="0" y2="1">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.16" />
            <stop offset="45%" stopColor="#000000" stopOpacity="0" />
            <stop offset="100%" stopColor="#020617" stopOpacity="0.38" />
          </linearGradient>
        </defs>
        <rect width={MAP_WIDTH} height={MAP_HEIGHT} fill="#12306f" />
        {elevation.rasterDataUrl ? (
          <image
            className="terrain-raster"
            href={elevation.rasterDataUrl}
            width={MAP_WIDTH}
            height={MAP_HEIGHT}
            preserveAspectRatio="none"
          />
        ) : null}
        <rect width={MAP_WIDTH} height={MAP_HEIGHT} fill="url(#elevationShade)" />
        <g className="elevation-contours">
          {elevation.contours.map((contour) => (
            <path key={contour.key} d={contour.d} className={contour.emphasis ? "emphasis" : ""} />
          ))}
        </g>
        {result.truthAvailable ? <path d={truthD} className="route-shadow" filter="url(#routeBlur)" /> : null}
        <path d={estimateD} className="route-shadow estimate" filter="url(#routeBlur)" />
        {result.truthAvailable ? <path d={truthD} className="route-real-path" /> : null}
        <path d={estimateD} className="route-found-path" />
        <rect x={startPoint.x - 8} y={startPoint.y - 8} width="16" height="16" className="map-dot start" />
        <rect x={finishPoint.x - 10} y={finishPoint.y - 10} width="20" height="20" className="map-dot finish" />
        <circle cx={currentMapPoint.x} cy={currentMapPoint.y} r="11" className="map-current-pulse" />
        <circle cx={currentMapPoint.x} cy={currentMapPoint.y} r="6" className="map-current-dot" />
        <text x={startPoint.x + 14} y={startPoint.y - 12} className="map-label">{result.truthAvailable ? TAIGA_ROUTE.startName : "старт оценки"}</text>
        <text x={finishPoint.x + 15} y={finishPoint.y + 5} className="map-label">{result.truthAvailable ? SCENARIO_META[scenario].shortLabel : "оценка"}</text>
        <text x={currentMapPoint.x + 13} y={currentMapPoint.y - 11} className="map-label">текущая оценка</text>
        <text x={currentMapPoint.x + 13} y={currentMapPoint.y + 9} className="map-coordinate-label">
          X {formatNumber(currentPoint.x, 0)} м · Y {formatNumber(currentPoint.y, 0)} м
        </text>
        <g className="elevation-range">
          <text x="32" y="38">низины {formatNumber(elevation.minElevationM, 0)} м</text>
          <text x="32" y="58">высоты {formatNumber(elevation.maxElevationM, 0)} м</text>
        </g>
        <g className="height-legend">
          <rect x={MAP_WIDTH - 292} y={MAP_HEIGHT - 58} width="250" height="12" fill="url(#heightLegendGradient)" />
          <text x={MAP_WIDTH - 292} y={MAP_HEIGHT - 24}>{formatNumber(elevation.minElevationM, 0)} м</text>
          <text x={MAP_WIDTH - 176} y={MAP_HEIGHT - 24}>{formatNumber((elevation.minElevationM + elevation.maxElevationM) / 2, 0)} м</text>
          <text x={MAP_WIDTH - 42} y={MAP_HEIGHT - 24} textAnchor="end">{formatNumber(elevation.maxElevationM, 0)} м</text>
        </g>
        <text x="32" y={MAP_HEIGHT - 38} className="map-scale">0     25     50 км</text>
        <line x1="34" y1={MAP_HEIGHT - 25} x2="218" y2={MAP_HEIGHT - 25} className="scale-line" />
      </svg>
      <div className="map-foot">
        <span>{scenarioMeta.region}</span>
        <span>{scenarioMeta.source}</span>
        <span>диапазон высот {formatNumber(elevation.minElevationM, 0)}-{formatNumber(elevation.maxElevationM, 0)} м</span>
      </div>
    </section>
  );
}

function CheckpointStatusStrip({ result }: { result: CheckpointTrajectoryResult }) {
  const status = result.status === "TRAJECTORY READY" ? "ok" : result.status === "PROFILE MISMATCH" ? "warn" : "bad";

  return (
    <section className="status-strip">
      <div>
        <span>Статус</span>
        <strong className={status}>{result.status === "TRAJECTORY READY" ? "ТРАЕКТОРИЯ ГОТОВА" : result.status === "PROFILE MISMATCH" ? "ПРОФИЛЬ НЕ СОВПАЛ" : "НЕТ ЦМР"}</strong>
      </div>
      <div>
        <span>точек</span>
        <strong>{result.inputSamples}</strong>
      </div>
      <div>
        <span>длина</span>
        <strong>{formatMeters(result.routeLengthM)}</strong>
      </div>
      <div>
        <span>шаг</span>
        <strong>{formatNumber(result.sampleDistanceM, 1)} м</strong>
      </div>
      <div>
        <span>Ошибка профиля</span>
        <strong>{result.profileRmseM === null ? "н/д" : formatMeters(result.profileRmseM)}</strong>
      </div>
    </section>
  );
}

function checkpointMapBounds(result: CheckpointTrajectoryResult): MapBounds {
  const path = result.points.map((point) => ({ x: point.x, y: point.y, t: point.index, elevationM: point.measuredHeightM }));
  return buildMapBounds(path);
}

function checkpointPath(points: CheckpointTrajectoryResult["points"], bounds: MapBounds): string {
  const step = Math.max(1, Math.floor(points.length / 320));
  return points
    .filter((_, index) => index % step === 0 || index === points.length - 1)
    .map((point, index) => {
      const projected = localToMap(point, bounds);
      return `${index === 0 ? "M" : "L"} ${projected.x.toFixed(1)} ${projected.y.toFixed(1)}`;
    })
    .join(" ");
}

function buildCheckpointElevationLayer(dem: CheckpointDem | null, bounds: MapBounds): ElevationLayer {
  if (!dem || !dem.bbox) {
    return { rasterDataUrl: null, contours: [], minElevationM: 0, maxElevationM: 0 };
  }

  return buildElevationLayer((localX, localY) => sampleCheckpointDem(dem, localX, localY), bounds);
}

function CheckpointMap({
  result,
  dem,
}: {
  result: CheckpointTrajectoryResult;
  dem: CheckpointDem | null;
}) {
  const bounds = useMemo(() => checkpointMapBounds(result), [result]);
  const elevation = useMemo(() => buildCheckpointElevationLayer(dem, bounds), [dem, bounds]);
  const start = result.points[0];
  const finish = result.points[result.points.length - 1];
  const startPoint = localToMap(start, bounds);
  const finishPoint = localToMap(finish, bounds);

  return (
    <section className="map-shell">
      <div className="map-head">
        <div>
          <span>Чекпоинт 3</span>
          <h2>Траектория по TXT-высотам</h2>
        </div>
        <div className="map-legend">
          <span><i className="route-found" /> траектория</span>
          <span><i className="elevation-high" /> карта высот</span>
        </div>
      </div>
      <svg className="satellite-map elevation-map" viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`} role="img" aria-label="Траектория чекпоинта">
        <defs>
          <filter id="checkpointTerrainSmooth">
            <feGaussianBlur stdDeviation="1.25" />
          </filter>
          <filter id="checkpointRouteBlur">
            <feGaussianBlur stdDeviation="3" />
          </filter>
        </defs>
        <rect width={MAP_WIDTH} height={MAP_HEIGHT} fill="#07111b" />
        {elevation.rasterDataUrl ? (
          <image
            className="terrain-raster"
            href={elevation.rasterDataUrl}
            width={MAP_WIDTH}
            height={MAP_HEIGHT}
            preserveAspectRatio="none"
          />
        ) : null}
        <g className="elevation-contours">
          {elevation.contours.map((contour) => (
            <path key={`checkpoint-${contour.key}`} d={contour.d} className={contour.emphasis ? "emphasis" : ""} />
          ))}
        </g>
        <path d={checkpointPath(result.points, bounds)} className="route-shadow" filter="url(#checkpointRouteBlur)" />
        <path d={checkpointPath(result.points, bounds)} className="route-found-path" />
        <rect x={startPoint.x - 8} y={startPoint.y - 8} width="16" height="16" className="map-dot start" />
        <rect x={finishPoint.x - 10} y={finishPoint.y - 10} width="20" height="20" className="map-dot finish" />
        <text x={startPoint.x + 14} y={startPoint.y - 12} className="map-label">старт</text>
        <text x={finishPoint.x + 15} y={finishPoint.y + 5} className="map-label">финиш</text>
        <text x="32" y="38" className="map-label">
          {dem ? `${dem.name} · ${dem.crsLabel}` : "GeoTIFF не загружен"}
        </text>
        {elevation.rasterDataUrl ? (
          <g className="elevation-range">
            <text x="32" y={MAP_HEIGHT - 58}>низины {formatNumber(elevation.minElevationM, 0)} м</text>
            <text x="32" y={MAP_HEIGHT - 38}>высоты {formatNumber(elevation.maxElevationM, 0)} м</text>
          </g>
        ) : null}
      </svg>
      <div className="map-foot">
        <span>точек {result.inputSamples}</span>
        <span>азимут {formatNumber(result.azimuthDeg, 0)}°</span>
        <span>старт X {formatNumber(result.startX, 0)} / Y {formatNumber(result.startY, 0)}</span>
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
        <strong>РВ + карта высот</strong>
      </div>
      <div>
        <span>Совпадение профилей</span>
        <strong>{result.best.correlation.toFixed(3)}</strong>
      </div>
      <div>
        <span>Ошибка профиля</span>
        <strong>{formatMeters(result.best.rmseM)}</strong>
      </div>
      <div>
        <span>Доверие к расчёту</span>
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
  const fixUsable = result.autopilotOutput.fixUsable;
  const primaryValue = (value: string) => fixUsable ? value : "не выдано";

  return (
    <aside className="solution-card">
      <div className="solution-top">
        <span>Оценка положения · T+ {formatDuration(currentElapsedS)}</span>
        <strong className={statusClass(result.navigationStatus)}>{statusLabel(result.navigationStatus)}</strong>
        <p>{result.statusReason}</p>
      </div>
      <div className="coordinates">
        <b>{primaryValue(formatCoord(currentWgs.lat, "lat"))}</b>
        <b>{primaryValue(formatCoord(currentWgs.lon, "lon"))}</b>
      </div>
      <div className="local-coordinates">
        <span>Локальные координаты карты высот</span>
        <div>
          <b>{primaryValue(`X ${formatNumber(currentPoint.x, 0)} м`)}</b>
          <b>{primaryValue(`Y ${formatNumber(currentPoint.y, 0)} м`)}</b>
        </div>
      </div>
      <div className="decision-grid">
        <div>
          <span>Путевая скорость</span>
          <strong>{primaryValue(`${formatNumber(result.best.speedMps, 1)} м/с`)}</strong>
        </div>
        <div>
          <span>Азимут</span>
          <strong>{primaryValue(`${formatNumber(result.best.azimuthDeg, 0)}°`)}</strong>
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
      {!fixUsable ? (
        <div className="local-coordinates">
          <span>Диагностический кандидат</span>
          <div>
            <b>X {formatNumber(currentPoint.x, 0)} м</b>
            <b>Y {formatNumber(currentPoint.y, 0)} м</b>
          </div>
        </div>
      ) : null}
      <div className="confidence">
        <div>
          <span>Доверие к расчёту</span>
          <strong>{confidence}%</strong>
        </div>
        <i><em style={{ width: `${confidence}%` }} /></i>
      </div>
    </aside>
  );
}

function CorrelationSurface({ result, compact = false }: { result: TerrainMatchResult; compact?: boolean }) {
  const width = compact ? 360 : 560;
  const height = compact ? 210 : 230;
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

function RegionPanel({ routeKm }: { routeKm: number }) {
  return (
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
          <span>Проверка</span>
          <h3>Метрики</h3>
        </div>
        <CheckCircle2 size={22} />
      </header>
      <div className="fact-list">
        <div><Gauge size={17} /><span>Пик совпадения: <b>{result.best.correlation.toFixed(3)}</b></span></div>
        <div><Gauge size={17} /><span>Второй пик: <b>{result.secondCorrelation?.toFixed(3) ?? "н/д"}</b></span></div>
        <div><Activity size={17} /><span>Разрыв пиков: <b>{result.ambiguity.toFixed(3)}</b></span></div>
        <div><Activity size={17} /><span>Ошибка профиля: <b>{formatMeters(result.best.rmseM)}</b></span></div>
        <div><Clock3 size={17} /><span>Время расчёта: <b>{formatNumber(result.computeMs, 0)} мс</b></span></div>
        <div><Gauge size={17} /><span>Доверие к расчёту: <b>{result.best.confidence}%</b></span></div>
        <div><AlertTriangle size={17} /><span>Изменчивость рельефа: <b>{formatMetric(result.terrainStdM, 1, "м")}</b></span></div>
        <div><AlertTriangle size={17} /><span>Контрольная сумма NMEA: <b>{result.nmeaQuality.checksumInvalid > 0 ? `${result.nmeaQuality.checksumInvalid} ошибок` : "норма"}</b></span></div>
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
  const primaryValue = (value: string) => output.fixUsable ? value : "не выдано";

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
          <b>{primaryValue(`${formatNumber(output.localXM, 0)} м`)}</b>
        </div>
        <div>
          <span>Y локальный</span>
          <b>{primaryValue(`${formatNumber(output.localYM, 0)} м`)}</b>
        </div>
        <div>
          <span>Широта</span>
          <b>{primaryValue(formatCoord(output.lat, "lat"))}</b>
        </div>
        <div>
          <span>Долгота</span>
          <b>{primaryValue(formatCoord(output.lon, "lon"))}</b>
        </div>
        <div>
          <span>Путевая скорость</span>
          <b>{primaryValue(`${formatNumber(output.groundSpeedMps, 1)} м/с`)}</b>
        </div>
        <div>
          <span>Азимут</span>
          <b>{primaryValue(`${formatNumber(output.azimuthDeg, 0)}°`)}</b>
        </div>
        <div>
          <span>Доверие к расчёту</span>
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
          <b>РВ + 1500 м + карта высот</b>
        </div>
        {!output.fixUsable ? (
          <div className="wide">
            <span>Диагностический кандидат</span>
            <b>
              X {formatNumber(output.localXM, 0)} м · Y {formatNumber(output.localYM, 0)} м · {formatNumber(output.groundSpeedMps, 1)} м/с · {formatNumber(output.azimuthDeg, 0)}°
            </b>
          </div>
        ) : null}
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

function CheckpointOutputPanel({ result }: { result: CheckpointTrajectoryResult }) {
  const final = result.points[result.points.length - 1];
  const withGlobal = result.points.filter((point) => point.lat !== null && point.lon !== null).length;

  return (
    <section className="panel autopilot-panel">
      <header>
        <div>
          <span>Выход чекпоинта</span>
          <h3>Набор координат</h3>
        </div>
        <Signal size={22} />
      </header>
      <div className="output-grid">
        <div>
          <span>Точек</span>
          <b>{result.inputSamples}</b>
        </div>
        <div>
          <span>Шаг профиля</span>
          <b>{formatNumber(result.sampleDistanceM, 1)} м</b>
        </div>
        <div>
          <span>Финальный X</span>
          <b>{formatNumber(final.x, 0)} м</b>
        </div>
        <div>
          <span>Финальный Y</span>
          <b>{formatNumber(final.y, 0)} м</b>
        </div>
        <div>
          <span>Широта</span>
          <b>{final.lat === null ? "н/д" : formatCoord(final.lat, "lat")}</b>
        </div>
        <div>
          <span>Долгота</span>
          <b>{final.lon === null ? "н/д" : formatCoord(final.lon, "lon")}</b>
        </div>
        <div>
          <span>Ошибка профиля</span>
          <b>{result.profileRmseM === null ? "н/д" : formatMeters(result.profileRmseM)}</b>
        </div>
        <div>
          <span>Покрытие ЦМР</span>
          <b>{formatNumber(result.coverageRatio * 100, 0)}%</b>
        </div>
        <div className="wide">
          <span>Карта</span>
          <b>{result.demName}</b>
        </div>
        <div className="wide">
          <span>Глобальные координаты</span>
          <b>{withGlobal > 0 ? `${withGlobal} точек` : "недоступны для этой СК"}</b>
        </div>
      </div>
    </section>
  );
}

function CheckpointPointsPanel({ result }: { result: CheckpointTrajectoryResult }) {
  const step = Math.max(1, Math.floor(result.points.length / 10));
  const rows = result.points.filter((_, index) => index % step === 0 || index === result.points.length - 1).slice(0, 12);

  return (
    <section className="panel nmea-panel checkpoint-points">
      <header>
        <div>
          <span>Точки траектории</span>
          <h3>Локальные и WGS-84</h3>
        </div>
        <strong>{result.points.length}</strong>
      </header>
      <div className="checkpoint-table">
        {rows.map((point) => (
          <code key={point.index}>
            #{point.index} X {point.x.toFixed(1)} Y {point.y.toFixed(1)}
            {point.lat !== null && point.lon !== null ? ` · ${point.lat.toFixed(6)}, ${point.lon.toFixed(6)}` : ""}
          </code>
        ))}
      </div>
    </section>
  );
}

function CheckpointAwaitingState({ rawText, error }: { rawText: string; error: string | null }) {
  const lineCount = rawText.split(/\r?\n/).filter((row) => row.trim()).length;

  return (
    <section className="panel nmea-empty-panel">
      <header>
        <div>
          <span>Чекпоинт 3</span>
          <h3>{error ? "Расчёт отклонён" : "Траектория не рассчитана"}</h3>
        </div>
        <AlertTriangle size={22} />
      </header>
      <div className="nmea-empty-grid">
        <div>
          <span>строк TXT</span>
          <b>{lineCount}</b>
        </div>
        <div>
          <span>состояние</span>
          <b>{error ? "ошибка" : lineCount > 0 ? "ожидает расчёт" : "нет входа"}</b>
        </div>
      </div>
      <p>{error ?? "Загрузите TXT с высотами, укажите старт X/Y и азимут. GeoTIFF нужен для сверки профиля и визуализации карты высот."}</p>
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
    return (localStorage.getItem("theme") as ThemeMode | null) ?? "light";
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
  const [activeScenario, setActiveScenario] = useState<ScenarioId>("taiga");
  const [inputMode, setInputMode] = useState<InputMode>("simulation");
  const [rawNmeaText, setRawNmeaText] = useState("");
  const [importedResult, setImportedResult] = useState<TerrainMatchResult | null>(null);
  const [nmeaError, setNmeaError] = useState<string | null>(null);
  const [isLoadingNmea, setLoadingNmea] = useState(false);
  const [rawCheckpointHeights, setRawCheckpointHeights] = useState("");
  const [checkpointDem, setCheckpointDem] = useState<CheckpointDem | null>(() => createTaigaCheckpointDem());
  const [checkpointResult, setCheckpointResult] = useState<CheckpointTrajectoryResult | null>(null);
  const [checkpointError, setCheckpointError] = useState<string | null>(null);
  const [isLoadingDem, setLoadingDem] = useState(false);
  const [checkpointForm, setCheckpointForm] = useState<CheckpointForm>({
    startX: 0,
    startY: 0,
    azimuthDeg: DEFAULT_MATCHER_CONFIG.trueAzimuthDeg,
    sampleDistanceM: DEFAULT_MATCHER_CONFIG.trueSpeedMps / DEFAULT_MATCHER_CONFIG.sampleRateHz,
    autoFitStep: true,
    stepMinM: 5,
    stepMaxM: 90,
  });
  const [replayState, setReplayState] = useState<FlightReplayState | null>(null);
  const [isReplayPaused, setReplayPaused] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [replaySpeedMultiplier, setReplaySpeedMultiplier] = useState(120);
  const activeScenarioMeta = SCENARIO_META[activeScenario];
  // Defer heavy terrain matching computation so slider thumb updates immediately.
  const deferredConfig = useDeferredValue(config);
  const simulationResult = useMemo(() => runTerrainMatching(deferredConfig), [deferredConfig]);
  const result = inputMode === "nmea" ? importedResult : inputMode === "simulation" ? simulationResult : null;
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
    setActiveScenario("taiga");
    setInputMode("simulation");
    setImportedResult(null);
    setNmeaError(null);
    setRawNmeaText("");
    setCheckpointResult(null);
    setCheckpointError(null);
    setRawCheckpointHeights("");
    setCheckpointDem(createTaigaCheckpointDem());
    setCheckpointForm({
      startX: 0,
      startY: 0,
      azimuthDeg: DEFAULT_MATCHER_CONFIG.trueAzimuthDeg,
      sampleDistanceM: DEFAULT_MATCHER_CONFIG.trueSpeedMps / DEFAULT_MATCHER_CONFIG.sampleRateHz,
      autoFitStep: true,
      stepMinM: 5,
      stepMaxM: 90,
    });
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

  function handleCheckpointTextChange(value: string) {
    setRawCheckpointHeights(value);
    setCheckpointResult(null);
    setCheckpointError(null);
    setInputMode("checkpoint");
  }

  function updateCheckpointForm(patch: Partial<CheckpointForm>) {
    setCheckpointForm((current) => ({ ...current, ...patch }));
    setCheckpointResult(null);
    setCheckpointError(null);
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

  async function loadCheckpointHeightsFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    if (!file) return;
    const text = await file.text();
    setRawCheckpointHeights(text);
    setCheckpointResult(null);
    setCheckpointError(null);
    setInputMode("checkpoint");
  }

  async function loadCheckpointGeoTiff(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    if (!file) return;
    setInputMode("checkpoint");
    setLoadingDem(true);
    setCheckpointError(null);
    try {
      const dem = await loadCheckpointDemFromGeoTiff(file);
      setCheckpointDem(dem);
      setCheckpointResult(null);
    } catch (error) {
      setCheckpointDem(null);
      setCheckpointResult(null);
      setCheckpointError(error instanceof Error ? error.message : "Не удалось прочитать GeoTIFF.");
    } finally {
      setLoadingDem(false);
    }
  }

  function useStandLog() {
    const text = simulationResult.nmea.join("\n");
    setRawNmeaText(text);
    solveNmeaText(text, config);
  }

  function solveNmeaText(text: string, solverConfig: Config = config) {
    setInputMode("nmea");
    setImportedResult(null);
    try {
      const solved = solveFromNmea(text, {
        terrainKind: solverConfig.terrainKind,
        baroAltitudeM: solverConfig.baroAltitudeM,
        sampleRateHz: solverConfig.sampleRateHz,
        speedMinMps: solverConfig.speedMinMps,
        speedMaxMps: solverConfig.speedMaxMps,
        speedStepMps: solverConfig.speedStepMps,
        plannedAzimuthDeg: solverConfig.plannedAzimuthDeg,
        courseLookaheadM: solverConfig.courseLookaheadM,
      });
      setImportedResult(solved);
      setNmeaError(null);
    } catch (error) {
      setImportedResult(null);
      setNmeaError(error instanceof Error ? error.message : "Не удалось разобрать журнал NMEA.");
    }
  }

  function analyzeNmeaLog() {
    solveNmeaText(rawNmeaText, config);
  }

  function analyzeCheckpoint() {
    setInputMode("checkpoint");
    try {
      const heightsM = parseCheckpointHeights(rawCheckpointHeights);
      const solved = buildCheckpointTrajectory({
        heightsM,
        dem: checkpointDem,
        startX: checkpointForm.startX,
        startY: checkpointForm.startY,
        azimuthDeg: checkpointForm.azimuthDeg,
        sampleDistanceM: checkpointForm.sampleDistanceM,
        autoFitStep: checkpointForm.autoFitStep,
        stepMinM: checkpointForm.stepMinM,
        stepMaxM: checkpointForm.stepMaxM,
      });
      setCheckpointResult(solved);
      setCheckpointError(null);
    } catch (error) {
      setCheckpointResult(null);
      setCheckpointError(error instanceof Error ? error.message : "Не удалось рассчитать траекторию чекпоинта.");
    }
  }

  function useCheckpointDemo() {
    const text = buildCheckpointDemoText();
    const nextForm: CheckpointForm = {
      startX: 0,
      startY: 0,
      azimuthDeg: DEFAULT_MATCHER_CONFIG.trueAzimuthDeg,
      sampleDistanceM: DEFAULT_MATCHER_CONFIG.trueSpeedMps / DEFAULT_MATCHER_CONFIG.sampleRateHz,
      autoFitStep: true,
      stepMinM: 5,
      stepMaxM: 90,
    };
    const dem = createTaigaCheckpointDem();
    setInputMode("checkpoint");
    setCheckpointDem(dem);
    setCheckpointForm(nextForm);
    setRawCheckpointHeights(text);
    try {
      setCheckpointResult(buildCheckpointTrajectory({
        heightsM: parseCheckpointHeights(text),
        dem,
        startX: nextForm.startX,
        startY: nextForm.startY,
        azimuthDeg: nextForm.azimuthDeg,
        sampleDistanceM: nextForm.sampleDistanceM,
        autoFitStep: nextForm.autoFitStep,
        stepMinM: nextForm.stepMinM,
        stepMaxM: nextForm.stepMaxM,
      }));
      setCheckpointError(null);
    } catch (error) {
      setCheckpointResult(null);
      setCheckpointError(error instanceof Error ? error.message : "Не удалось подготовить пример TXT.");
    }
  }

  function exportCheckpointCsv() {
    if (!checkpointResult) return;
    const blob = new Blob([checkpointResultToCsv(checkpointResult)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "krot-checkpoint-trajectory.csv";
    link.click();
    URL.revokeObjectURL(url);
  }

  async function applyScenario(scenario: ScenarioId) {
    setActiveScenario(scenario);
    setReplayState(null);

    if (scenario !== "bad-log") {
      const nextConfig = SCENARIO_CONFIGS[scenario];
      setConfig(nextConfig);
      setInputMode("simulation");
      setImportedResult(null);
      setNmeaError(null);
      setRawNmeaText("");
      return;
    }

    const nextConfig = DEFAULT_MATCHER_CONFIG;
    setConfig(nextConfig);
    setInputMode("nmea");
    setImportedResult(null);
    setNmeaError(null);
    setLoadingNmea(true);
    try {
      const response = await fetch(PX4_DEMO_NMEA_URL, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      setRawNmeaText(text);
      solveNmeaText(text, nextConfig);
    } catch {
      setImportedResult(null);
      setNmeaError("Не удалось загрузить несовместимый журнал из examples.");
    } finally {
      setLoadingNmea(false);
    }
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
      setActiveScenario("taiga");
      setConfig(DEFAULT_MATCHER_CONFIG);
      setRawNmeaText(text);
      solveNmeaText(text, DEFAULT_MATCHER_CONFIG);
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
      setActiveScenario("bad-log");
      setConfig(DEFAULT_MATCHER_CONFIG);
      setRawNmeaText(text);
      solveNmeaText(text, DEFAULT_MATCHER_CONFIG);
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
        <div className="top-status"><Signal size={15} /> РВ + 1500 М + КАРТА ВЫСОТ / КОРРЕЛЯЦИОННЫЙ ПОИСК</div>
        <div className="top-actions">
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
              value={activeScenarioMeta.source}
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
              help="Радиовысотомер: расстояние от борта до поверхности. Формат входа - NMEA-0183."
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
                  help="Параметр стенда. Итоговая Vпут справа - результат перебора алгоритма."
                  onChange={(value) => updateConfig("trueSpeedMps", value)}
                />
                <Slider
                  label="Азимут"
                  value={config.trueAzimuthDeg}
                  min={0}
                  max={359}
                  step={1}
                  unit="°"
                  help="Параметр стенда. Итоговый азимут справа - найденный максимум совпадения."
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
            ) : inputMode === "nmea" ? (
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
            ) : (
              <CheckpointImportPanel
                rawText={rawCheckpointHeights}
                form={checkpointForm}
                dem={checkpointDem}
                result={checkpointResult}
                error={checkpointError}
                isLoadingDem={isLoadingDem}
                onTextChange={handleCheckpointTextChange}
                onHeightsFileChange={loadCheckpointHeightsFile}
                onGeoTiffChange={loadCheckpointGeoTiff}
                onFormChange={updateCheckpointForm}
                onAnalyze={analyzeCheckpoint}
                onUseDemo={useCheckpointDemo}
                onExportCsv={exportCheckpointCsv}
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
          {inputMode !== "checkpoint" && result ? (
            <>
              <CorrelationSurface result={result} compact />
              <RegionPanel routeKm={routeKm} />
            </>
          ) : null}
        </aside>

        <section className="center-stage">
          {inputMode === "checkpoint" ? (
            checkpointResult ? (
              <>
                <CheckpointStatusStrip result={checkpointResult} />
                <CheckpointMap result={checkpointResult} dem={checkpointDem} />
                <CheckpointPointsPanel result={checkpointResult} />
              </>
            ) : (
              <CheckpointAwaitingState rawText={rawCheckpointHeights} error={checkpointError} />
            )
          ) : result && currentPoint ? (
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
              <ScenarioPanel activeScenario={activeScenario} isLoading={isLoadingNmea} onSelect={applyScenario} />
              <SatelliteMap result={result} currentPoint={currentPoint} scenario={activeScenario} />
              <div className="bottom-grid">
                <NmeaStream result={result} currentIndex={currentIndex} />
                <TerrainProfile result={result} />
              </div>
            </>
          ) : (
            <NmeaAwaitingState rawText={rawNmeaText} error={nmeaError} />
          )}
        </section>

        <aside className="right-rail">
          {inputMode === "checkpoint" ? (
            checkpointResult ? (
              <>
                <CheckpointOutputPanel result={checkpointResult} />
                <section className="panel facts-panel">
                  <header>
                    <div>
                      <span>Проверка</span>
                      <h3>Чекпоинт 3</h3>
                    </div>
                    <CheckCircle2 size={22} />
                  </header>
                  <div className="fact-list">
                    <div><MapPinned size={17} /><span>Старт: <b>X {formatNumber(checkpointResult.startX, 0)} / Y {formatNumber(checkpointResult.startY, 0)}</b></span></div>
                    <div><Gauge size={17} /><span>Азимут: <b>{formatNumber(checkpointResult.azimuthDeg, 0)}°</b></span></div>
                    <div><Activity size={17} /><span>Покрытие ЦМР: <b>{formatNumber(checkpointResult.coverageRatio * 100, 0)}%</b></span></div>
                    <div><Activity size={17} /><span>СКО профиля: <b>{checkpointResult.profileRmseM === null ? "н/д" : formatMeters(checkpointResult.profileRmseM)}</b></span></div>
                    <div><Clock3 size={17} /><span>Режим: <b>TXT + GeoTIFF</b></span></div>
                    <div><AlertTriangle size={17} /><span>Статус: <b>{checkpointResult.statusReason}</b></span></div>
                  </div>
                </section>
              </>
            ) : (
              <NoNavigationOutputPanel rawText={rawCheckpointHeights} error={checkpointError} />
            )
          ) : result && currentPoint ? (
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
