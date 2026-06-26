import { ReactNode, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Gauge,
  MapPinned,
  Pause,
  RotateCcw,
  Satellite,
  Settings,
  Signal,
} from "lucide-react";
import { FlightPreview3D } from "./FlightPreview3D";
import {
  DEFAULT_MATCHER_CONFIG,
  MatchPoint,
  TAIGA_ROUTE,
  TerrainMatchResult,
  localPointToWgs84,
  routeLengthM,
  runTerrainMatching,
} from "./terrainMatcher";

type Config = typeof DEFAULT_MATCHER_CONFIG;
type ViewMode = "operator" | "method";

const TILE_SIZE = 256;
const MAP_WIDTH = 980;
const MAP_HEIGHT = 560;

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

function angleError(a: number, b: number): number {
  return Math.abs(((a - b + 540) % 360) - 180);
}

function Help({ text }: { text: string }) {
  return (
    <span className="help" tabIndex={0} aria-label={text}>
      ?
      <span>{text}</span>
    </span>
  );
}

function MiniButton({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <button className="mini-button" type="button" aria-label={label}>
      {icon}
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

function tileProject(lat: number, lon: number, zoom: number) {
  const scale = 2 ** zoom;
  const x = ((lon + 180) / 360) * scale;
  const latRad = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * scale;
  return { x, y };
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

function SatelliteMap({ result }: { result: TerrainMatchResult }) {
  const zoom = 8;
  const start = result.truthPath[0];
  const finish = result.truthPath[result.truthPath.length - 1];
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

  const truthD = buildRoutePath(result.truthPath, centerTile, zoom);
  const estimateD = buildRoutePath(result.estimatedPath, centerTile, zoom);
  const startPoint = pointOnMap(start, centerTile, zoom);
  const finishPoint = pointOnMap(finish, centerTile, zoom);

  return (
    <section className="map-shell">
      <div className="map-head">
        <div>
          <span>ЦМР + траектория</span>
          <h2>{TAIGA_ROUTE.routeName}</h2>
        </div>
        <div className="map-legend">
          <span><i className="route-real" /> истинная траектория</span>
          <span><i className="route-found" /> оценка алгоритма</span>
        </div>
      </div>
      <svg className="satellite-map" viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`} role="img" aria-label="Спутниковая карта тайги с маршрутом">
        <defs>
          <filter id="routeBlur">
            <feGaussianBlur stdDeviation="3" />
          </filter>
          <linearGradient id="mapShade" x1="0" x2="1" y1="0" y2="1">
            <stop offset="0%" stopColor="#061117" stopOpacity="0.2" />
            <stop offset="100%" stopColor="#2dd4bf" stopOpacity="0.12" />
          </linearGradient>
        </defs>
        <rect width={MAP_WIDTH} height={MAP_HEIGHT} fill="#17251b" />
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
        <rect width={MAP_WIDTH} height={MAP_HEIGHT} fill="rgba(3, 13, 18, 0.18)" />
        <rect width={MAP_WIDTH} height={MAP_HEIGHT} fill="url(#mapShade)" />
        <path d={truthD} className="route-shadow" filter="url(#routeBlur)" />
        <path d={truthD} className="route-real-path" />
        <path d={estimateD} className="route-found-path" />
        <rect x={startPoint.x - 8} y={startPoint.y - 8} width="16" height="16" className="map-dot start" />
        <rect x={finishPoint.x - 10} y={finishPoint.y - 10} width="20" height="20" className="map-dot finish" />
        <text x={startPoint.x + 14} y={startPoint.y - 12} className="map-label">{TAIGA_ROUTE.startName}</text>
        <text x={finishPoint.x + 15} y={finishPoint.y + 5} className="map-label">{TAIGA_ROUTE.finishName}</text>
        <text x="32" y={MAP_HEIGHT - 38} className="map-scale">0     25     50 км</text>
        <line x1="34" y1={MAP_HEIGHT - 25} x2="218" y2={MAP_HEIGHT - 25} className="scale-line" />
      </svg>
      <div className="map-foot">
        <span>{TAIGA_ROUTE.region}</span>
        <span>{TAIGA_ROUTE.demName}</span>
        <span>старт {formatCoord(startWgs.lat, "lat")} · {formatCoord(startWgs.lon, "lon")}</span>
      </div>
    </section>
  );
}

function StatusStrip({ result }: { result: TerrainMatchResult }) {
  return (
    <section className="status-strip">
      <div>
        <span>Статус</span>
        <strong>Привязка есть</strong>
      </div>
      <div>
        <span>ГНСС</span>
        <strong className="bad">нет данных</strong>
      </div>
      <div>
        <span>corr</span>
        <strong>{result.best.correlation.toFixed(3)}</strong>
      </div>
      <div>
        <span>СКО</span>
        <strong>{formatMeters(result.best.rmseM)}</strong>
      </div>
      <div>
        <span>достоверность</span>
        <strong>{result.best.confidence}%</strong>
      </div>
    </section>
  );
}

function SolutionPanel({ result }: { result: TerrainMatchResult }) {
  const finalPoint = result.estimatedPath[result.estimatedPath.length - 1];
  const finalWgs = localPointToWgs84(finalPoint);
  const confidence = result.best.confidence;
  const status = confidence >= 80 ? "ПРИВЯЗКА ПОДТВЕРЖДЕНА" : confidence >= 55 ? "ТРЕБУЕТ КОНТРОЛЯ" : "РЕЛЬЕФ НЕДОСТАТОЧЕН";

  return (
    <aside className="solution-card">
      <div className="solution-top">
        <span>Оценка положения</span>
        <strong>{status}</strong>
      </div>
      <div className="coordinates">
        <b>{formatCoord(finalWgs.lat, "lat")}</b>
        <b>{formatCoord(finalWgs.lon, "lon")}</b>
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
          <span>СКО профиля</span>
          <strong>{formatMeters(result.best.rmseM)}</strong>
        </div>
        <div>
          <span>Длина трассы</span>
          <strong>{formatMeters(routeLengthM(result.truthPath))}</strong>
        </div>
      </div>
      <div className="confidence">
        <div>
          <span>Достоверность оценки</span>
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
          <span>Корреляция</span>
          <h3>Поверхность кандидатов</h3>
        </div>
        <strong>{result.best.correlation.toFixed(3)}</strong>
      </header>
      <svg viewBox={`0 0 ${width} ${height}`} className="heatmap" role="img" aria-label="Карта корреляции по направлению и скорости">
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
          <h3>MSL = BARO - RA</h3>
        </div>
        <div className="chart-legend">
          <span><i className="measured" /> измерено РВ</span>
          <span><i className="reference" /> эталон ЦМР</span>
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

function NmeaStream({ result }: { result: TerrainMatchResult }) {
  const rows = result.nmea.slice(-10).reverse();

  return (
    <section className="panel nmea-panel">
      <header>
        <div>
          <span>Журнал NMEA</span>
          <h3>Поток радиовысотомера</h3>
        </div>
        <strong>{result.config.sampleRateHz} Гц</strong>
      </header>
      <div className="nmea-table">
        {rows.map((row, index) => (
          <code key={`${row}-${index}`}>{row}</code>
        ))}
      </div>
    </section>
  );
}

function ValidationPanel({ result, finalErrorDeg }: { result: TerrainMatchResult; finalErrorDeg: number }) {
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
        <div><Gauge size={17} /><span>corr: <b>{result.best.correlation.toFixed(3)}</b></span></div>
        <div><Activity size={17} /><span>Δaz: <b>{formatNumber(finalErrorDeg, 0)}°</b></span></div>
        <div><Clock3 size={17} /><span>расчёт: <b>{formatNumber(result.computeMs, 0)} мс</b></span></div>
        <div><AlertTriangle size={17} /><span>защита плоского рельефа: снижает доверие</span></div>
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
        <span>РВ AGL показывает расстояние от борта до поверхности.</span>
      </article>
      <article>
        <strong>2. Барометр</strong>
        <span>БАРО MSL задаёт абсолютную высоту борта над уровнем моря.</span>
      </article>
      <article>
        <strong>3. Профиль</strong>
        <span>MSL = BARO - RA. Так получается профиль высот земли вдоль трассы.</span>
      </article>
      <article>
        <strong>4. Корреляция</strong>
        <span>Система перебирает азимут 0-359° и скорость, затем ищет максимум corr.</span>
      </article>
    </section>
  );
}

export function App() {
  const [config, setConfig] = useState<Config>(DEFAULT_MATCHER_CONFIG);
  const [mode, setMode] = useState<ViewMode>("operator");
  const result = useMemo(() => runTerrainMatching(config), [config]);
  const routeKm = routeLengthM(result.truthPath) / 1000;
  const finalErrorDeg = angleError(result.best.azimuthDeg, config.trueAzimuthDeg);

  function updateConfig<K extends keyof Config>(key: K, value: Config[K]) {
    setConfig((current) => ({ ...current, [key]: value }));
  }

  function reset() {
    setConfig(DEFAULT_MATCHER_CONFIG);
  }

  return (
    <div className="ops-shell">
      <header className="ops-topbar">
        <div className="brand-block">
          <div className="brand-icon"><MapPinned size={24} /></div>
          <div>
            <strong>КРОТ</strong>
            <span>команда «Где мы, Бариста?»</span>
          </div>
        </div>
        <div className="top-status"><Signal size={15} /> РЕЛЬЕФНАЯ НАВИГАЦИЯ / ГНСС НЕДОСТУПНА</div>
        <div className="top-actions">
          <button className={mode === "operator" ? "active" : ""} type="button" onClick={() => setMode("operator")}>Оператор</button>
          <button className={mode === "method" ? "active" : ""} type="button" onClick={() => setMode("method")}>Методика</button>
          <MiniButton icon={<Pause size={17} />} label="Пауза" />
          <MiniButton icon={<Settings size={17} />} label="Настройки" />
        </div>
      </header>

      <main className="ops-grid">
        <aside className="left-rail">
          <section className="rail-panel">
            <h2>Входные данные</h2>
            <InputRow
              label="ЦМР"
              value={TAIGA_ROUTE.demName}
              help="Цифровая модель рельефа. В рабочем контуре заменяется на Copernicus GLO-30, SRTM или ALOS."
            />
            <InputRow
              label="БАРО MSL"
              value={`${formatNumber(config.baroAltitudeM, 0)} м`}
              help="Абсолютная высота борта над уровнем моря. В кейсе задано 1500 м."
            />
            <InputRow
              label="РВ AGL"
              value={`NMEA · ${config.sampleRateHz} Гц`}
              help="Радиовысотомер: расстояние от борта до поверхности. Формат входа — NMEA-0183."
            />
            <InputRow
              label="Диапазон Vпут"
              value={`${config.speedMinMps}-${config.speedMaxMps} м/с`}
              help="Диапазон перебора путевой скорости."
            />
          </section>

          <section className="rail-panel">
            <div className="rail-title">
              <h2>Параметры симуляции</h2>
              <button type="button" onClick={reset} aria-label="Сбросить вводные"><RotateCcw size={16} /></button>
            </div>
            <Slider
              label="Vпут"
              value={config.trueSpeedMps}
              min={35}
              max={65}
              step={1}
              unit="м/с"
              help="Стендовая скорость. Алгоритм восстанавливает её по максимуму корреляции."
              onChange={(value) => updateConfig("trueSpeedMps", value)}
            />
            <Slider
              label="Азимут"
              value={config.trueAzimuthDeg}
              min={0}
              max={359}
              step={1}
              unit="°"
              help="Путевой угол: 0° — север, 90° — восток."
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
          </section>

          <section className="rail-panel">
            <h2>Состояние системы</h2>
            <ToggleRow label="ГНСС" enabled={false} />
            <ToggleRow label="БАРО" enabled />
            <ToggleRow label="РВ" enabled />
            <ToggleRow label="ЦМР" enabled />
            <ToggleRow label="КОНТУР" enabled />
          </section>
        </aside>

        <section className="center-stage">
          {mode === "operator" ? (
            <>
              <StatusStrip result={result} />
              <FlightPreview3D result={result} />
              <SatelliteMap result={result} />
              <div className="bottom-grid">
                <NmeaStream result={result} />
                <TerrainProfile result={result} />
              </div>
            </>
          ) : (
            <MethodologyMode />
          )}
        </section>

        <aside className="right-rail">
          <SolutionPanel result={result} />
          <ValidationPanel result={result} finalErrorDeg={finalErrorDeg} />
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
          </section>
        </aside>
      </main>
    </div>
  );
}

export default App;
