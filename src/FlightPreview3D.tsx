import { useEffect, useRef } from "react";
import * as THREE from "three";
import { COPERNICUS_TAIGA_DEM } from "./copernicusDemSample";
import { MatchPoint, TerrainMatchResult, localPointToWgs84, routeLengthM } from "./terrainMatcher";

type FlightPreview3DProps = {
  result: TerrainMatchResult;
  replayState: FlightReplayState | null;
  replaySpeedMultiplier: number;
  isReplayPaused: boolean;
  onReplayChange: (state: FlightReplayState) => void;
  theme: string;
};

function resolveTheme(theme: string): "light" | "dark" {
  if (theme === "light") return "light";
  if (theme === "dark") return "dark";
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function applyTheme3D(
  isLight: boolean,
  scene: THREE.Scene,
  horizon: THREE.Mesh | null,
  ambient: THREE.HemisphereLight | null,
) {
  const sky = isLight ? 0x87c5e8 : 0x071018;
  scene.background = new THREE.Color(sky);
  if (scene.fog instanceof THREE.FogExp2) scene.fog.color.set(sky);
  if (horizon) (horizon.material as THREE.MeshBasicMaterial).color.set(isLight ? 0x87c5e8 : 0x10271c);
  if (ambient) {
    ambient.color.set(isLight ? 0xd4eeff : 0xc8f7e7);
    ambient.groundColor.set(isLight ? 0x6b9e5c : 0x17231c);
  }
}

export type FlightReplayState = {
  pointIndex: number;
  elapsedS: number;
  progress: number;
  aglM: number;
};

const SCENE_WIDTH = 28;
const SCENE_DEPTH = 11.2;
const TERRAIN_SEGMENTS_X = 180;
const TERRAIN_SEGMENTS_Z = 72;
const TEXTURE_WIDTH = 1024;
const TEXTURE_HEIGHT = 512;
const SATELLITE_TILE_SIZE = 256;
const SATELLITE_ZOOM = 9;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp((value - edge0) / Math.max(0.0001, edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function noise2d(x: number, y: number): number {
  const value = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
  return value - Math.floor(value);
}

function sampleDemLatLon(lat: number, lon: number): number {
  const { bounds, width, height, elevationM } = COPERNICUS_TAIGA_DEM;
  const px = clamp(((lon - bounds.lonMin) / (bounds.lonMax - bounds.lonMin)) * (width - 1), 0, width - 1);
  const py = clamp(((bounds.latMax - lat) / (bounds.latMax - bounds.latMin)) * (height - 1), 0, height - 1);
  const x0 = Math.floor(px);
  const y0 = Math.floor(py);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
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

function sampleSmoothedDemLatLon(lat: number, lon: number): number {
  const offsets = [
    [0, 0, 4],
    [0.006, 0, 1],
    [-0.006, 0, 1],
    [0, 0.006, 1],
    [0, -0.006, 1],
    [0.004, 0.004, 0.7],
    [0.004, -0.004, 0.7],
    [-0.004, 0.004, 0.7],
    [-0.004, -0.004, 0.7],
  ];
  let sum = 0;
  let weight = 0;
  for (const [dLat, dLon, itemWeight] of offsets) {
    sum += sampleDemLatLon(lat + dLat, lon + dLon) * itemWeight;
    weight += itemWeight;
  }
  return sum / weight;
}

function elevationToSceneY(elevationM: number): number {
  const min = COPERNICUS_TAIGA_DEM.minElevationM;
  const max = COPERNICUS_TAIGA_DEM.maxElevationM;
  return ((elevationM - min) / Math.max(1, max - min) - 0.46) * 1.18;
}

function sceneToLatLon(x: number, z: number) {
  const { bounds } = COPERNICUS_TAIGA_DEM;
  const lat = (bounds.latMin + bounds.latMax) / 2 - (z / SCENE_DEPTH) * (bounds.latMax - bounds.latMin);
  const lon = (bounds.lonMin + bounds.lonMax) / 2 + (x / SCENE_WIDTH) * (bounds.lonMax - bounds.lonMin);
  return { lat, lon };
}

function wgsToScene(lat: number, lon: number, elevationM = sampleDemLatLon(lat, lon)): THREE.Vector3 {
  const { bounds } = COPERNICUS_TAIGA_DEM;
  const x = ((lon - (bounds.lonMin + bounds.lonMax) / 2) / (bounds.lonMax - bounds.lonMin)) * SCENE_WIDTH;
  const z = -((lat - (bounds.latMin + bounds.latMax) / 2) / (bounds.latMax - bounds.latMin)) * SCENE_DEPTH;
  return new THREE.Vector3(x, elevationToSceneY(elevationM), z);
}

function terrainYAtScene(x: number, z: number): number {
  const { lat, lon } = sceneToLatLon(x, z);
  return elevationToSceneY(sampleSmoothedDemLatLon(lat, lon));
}

function tileProject(lat: number, lon: number, zoom: number) {
  const scale = 2 ** zoom;
  const x = ((lon + 180) / 360) * scale;
  const latRad = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * scale;
  return { x, y };
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Tile load failed: ${src}`));
    image.src = src;
  });
}

async function makeSatelliteTexture(): Promise<THREE.CanvasTexture> {
  const canvas = document.createElement("canvas");
  canvas.width = TEXTURE_WIDTH;
  canvas.height = TEXTURE_HEIGHT;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D context is unavailable");

  const { bounds } = COPERNICUS_TAIGA_DEM;
  const topLeft = tileProject(bounds.latMax, bounds.lonMin, SATELLITE_ZOOM);
  const bottomRight = tileProject(bounds.latMin, bounds.lonMax, SATELLITE_ZOOM);
  const projectedWidth = Math.max(0.0001, bottomRight.x - topLeft.x);
  const projectedHeight = Math.max(0.0001, bottomRight.y - topLeft.y);
  const tileMinX = Math.floor(topLeft.x);
  const tileMaxX = Math.ceil(bottomRight.x);
  const tileMinY = Math.floor(topLeft.y);
  const tileMaxY = Math.ceil(bottomRight.y);
  const tiles: Promise<void>[] = [];

  context.fillStyle = "#173222";
  context.fillRect(0, 0, TEXTURE_WIDTH, TEXTURE_HEIGHT);

  for (let x = tileMinX; x <= tileMaxX; x += 1) {
    for (let y = tileMinY; y <= tileMaxY; y += 1) {
      tiles.push(
        loadImage(`https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${SATELLITE_ZOOM}/${y}/${x}`).then(
          (image) => {
            const dx = ((x - topLeft.x) / projectedWidth) * TEXTURE_WIDTH;
            const dy = ((y - topLeft.y) / projectedHeight) * TEXTURE_HEIGHT;
            const dw = (1 / projectedWidth) * TEXTURE_WIDTH;
            const dh = (1 / projectedHeight) * TEXTURE_HEIGHT;
            context.drawImage(image, 0, 0, SATELLITE_TILE_SIZE, SATELLITE_TILE_SIZE, dx, dy, dw, dh);
          },
        ),
      );
    }
  }

  const settled = await Promise.allSettled(tiles);
  const loaded = settled.filter((item) => item.status === "fulfilled").length;
  if (loaded < Math.max(4, tiles.length * 0.45)) {
    throw new Error("Not enough satellite tiles loaded");
  }

  context.globalCompositeOperation = "multiply";
  context.fillStyle = "rgba(4, 18, 16, 0.42)";
  context.fillRect(0, 0, TEXTURE_WIDTH, TEXTURE_HEIGHT);
  context.globalCompositeOperation = "source-over";
  context.fillStyle = "rgba(42, 212, 191, 0.06)";
  context.fillRect(0, 0, TEXTURE_WIDTH, TEXTURE_HEIGHT);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return texture;
}

function colorMix(a: number[], b: number[], t: number): number[] {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

function makeTerrainTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = TEXTURE_WIDTH;
  canvas.height = TEXTURE_HEIGHT;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D context is unavailable");

  const image = context.createImageData(TEXTURE_WIDTH, TEXTURE_HEIGHT);
  const { bounds, minElevationM, maxElevationM } = COPERNICUS_TAIGA_DEM;

  for (let y = 0; y < TEXTURE_HEIGHT; y += 1) {
    const lat = bounds.latMax - (y / (TEXTURE_HEIGHT - 1)) * (bounds.latMax - bounds.latMin);
    for (let x = 0; x < TEXTURE_WIDTH; x += 1) {
      const lon = bounds.lonMin + (x / (TEXTURE_WIDTH - 1)) * (bounds.lonMax - bounds.lonMin);
      const elevation = sampleDemLatLon(lat, lon);
      const north = sampleDemLatLon(lat + 0.002, lon);
      const east = sampleDemLatLon(lat, lon + 0.002);
      const relief = (elevation - minElevationM) / Math.max(1, maxElevationM - minElevationM);
      const slope = clamp((Math.abs(north - elevation) + Math.abs(east - elevation)) / 72, 0, 1);
      const canopy = noise2d(x * 0.019, y * 0.023) * 0.55 + noise2d(x * 0.071 + 12.2, y * 0.067) * 0.45;
      const bog = smoothstep(0.1, 0.45, canopy) * smoothstep(0.56, 0.25, relief);
      const ridge = smoothstep(0.42, 0.78, relief) * smoothstep(0.05, 0.55, slope);

      let color = colorMix([20, 42, 33], [43, 72, 43], canopy);
      color = colorMix(color, [74, 74, 44], bog * 0.46);
      color = colorMix(color, [92, 87, 63], ridge * 0.38);
      color = colorMix(color, [12, 22, 25], smoothstep(0.0, 0.16, slope) * 0.16);

      const index = (y * TEXTURE_WIDTH + x) * 4;
      image.data[index] = clamp(color[0], 0, 255);
      image.data[index + 1] = clamp(color[1], 0, 255);
      image.data[index + 2] = clamp(color[2], 0, 255);
      image.data[index + 3] = 255;
    }
  }

  context.putImageData(image, 0, 0);
  context.globalCompositeOperation = "source-over";
  context.lineCap = "round";
  context.lineJoin = "round";

  const rivers = [
    { y: 0.7, color: "rgba(15, 72, 82, 0.82)", width: 18 },
    { y: 0.34, color: "rgba(13, 58, 69, 0.65)", width: 9 },
  ];

  rivers.forEach((river, index) => {
    context.strokeStyle = river.color;
    context.lineWidth = river.width;
    context.beginPath();
    context.moveTo(-40, TEXTURE_HEIGHT * river.y);
    context.bezierCurveTo(
      TEXTURE_WIDTH * 0.22,
      TEXTURE_HEIGHT * (river.y - 0.14 + index * 0.05),
      TEXTURE_WIDTH * 0.47,
      TEXTURE_HEIGHT * (river.y + 0.09),
      TEXTURE_WIDTH * 0.72,
      TEXTURE_HEIGHT * (river.y - 0.06),
    );
    context.bezierCurveTo(
      TEXTURE_WIDTH * 0.87,
      TEXTURE_HEIGHT * (river.y - 0.13),
      TEXTURE_WIDTH * 0.94,
      TEXTURE_HEIGHT * (river.y + 0.08),
      TEXTURE_WIDTH + 40,
      TEXTURE_HEIGHT * (river.y - 0.02),
    );
    context.stroke();
  });

  context.globalCompositeOperation = "multiply";
  context.fillStyle = "rgba(2, 9, 12, 0.12)";
  context.fillRect(0, 0, TEXTURE_WIDTH, TEXTURE_HEIGHT);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  return texture;
}

function makeTerrainMesh(texture: THREE.Texture): THREE.Mesh {
  const geometry = new THREE.PlaneGeometry(SCENE_WIDTH, SCENE_DEPTH, TERRAIN_SEGMENTS_X, TERRAIN_SEGMENTS_Z);
  geometry.rotateX(-Math.PI / 2);
  const position = geometry.getAttribute("position") as THREE.BufferAttribute;

  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i);
    const z = position.getZ(i);
    position.setY(i, terrainYAtScene(x, z));
  }

  geometry.computeVertexNormals();

  return new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({
      map: texture,
      roughness: 0.96,
      metalness: 0,
      color: 0xe4f2dc,
    }),
  );
}

function makeHorizonPlane(): THREE.Mesh {
  const geometry = new THREE.PlaneGeometry(SCENE_WIDTH * 2.4, SCENE_DEPTH * 2.25, 1, 1);
  geometry.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({
      color: 0x10271c,
    }),
  );
  mesh.position.y = elevationToSceneY(COPERNICUS_TAIGA_DEM.minElevationM) - 0.08;
  return mesh;
}

function pointToScene(point: MatchPoint, clearance = 0.05): THREE.Vector3 {
  const wgs = localPointToWgs84(point);
  const scenePoint = wgsToScene(wgs.lat, wgs.lon, sampleSmoothedDemLatLon(wgs.lat, wgs.lon));
  scenePoint.y += clearance;
  return scenePoint;
}

function sampledPath(path: MatchPoint[], maxPoints: number): THREE.Vector3[] {
  const step = Math.max(1, Math.floor(path.length / maxPoints));
  return path
    .filter((_, index) => index % step === 0 || index === path.length - 1)
    .map((point) => pointToScene(point));
}

function makeRouteTube(points: THREE.Vector3[], color: number, radius: number, opacity: number): THREE.Mesh {
  const curve = new THREE.CatmullRomCurve3(points);
  return new THREE.Mesh(
    new THREE.TubeGeometry(curve, Math.max(24, points.length * 2), radius, 8, false),
    new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 0.28,
      transparent: true,
      opacity,
      roughness: 0.28,
    }),
  );
}

function makeRouteRibbon(points: THREE.Vector3[]): THREE.Mesh {
  const curve = new THREE.CatmullRomCurve3(points);
  return new THREE.Mesh(
    new THREE.TubeGeometry(curve, Math.max(80, points.length * 3), 0.032, 10, false),
    new THREE.MeshStandardMaterial({
      color: 0x39d9ff,
      emissive: 0x1aa7c6,
      emissiveIntensity: 0.16,
      transparent: true,
      opacity: 0.34,
      roughness: 0.46,
    }),
  );
}

function clampToScene(point: THREE.Vector3): THREE.Vector3 {
  return new THREE.Vector3(
    clamp(point.x, -SCENE_WIDTH / 2 + 0.55, SCENE_WIDTH / 2 - 0.55),
    point.y,
    clamp(point.z, -SCENE_DEPTH / 2 + 0.35, SCENE_DEPTH / 2 - 0.35),
  );
}

function buildReplayRoute(path: MatchPoint[]): THREE.Vector3[] {
  return sampledPath(path, 260).map((point) => {
    const clamped = clampToScene(point);
    clamped.y = terrainYAtScene(clamped.x, clamped.z) + 0.16;
    return clamped;
  });
}

function routePosition(curve: THREE.CatmullRomCurve3, t: number): THREE.Vector3 {
  return curve.getPointAt(clamp(t, 0, 1));
}

function makeWingGeometry(span: number, rootChord: number, tipChord: number): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  const halfSpan = span / 2;
  const vertices = new Float32Array([
    -halfSpan, 0, -tipChord / 2,
    0, 0, -rootChord / 2,
    0, 0, rootChord / 2,
    -halfSpan, 0, tipChord / 2,
    halfSpan, 0, -tipChord / 2,
    halfSpan, 0, tipChord / 2,
  ]);
  geometry.setAttribute("position", new THREE.BufferAttribute(vertices, 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3, 1, 4, 5, 1, 5, 2]);
  geometry.computeVertexNormals();
  return geometry;
}

function makeDrone() {
  const group = new THREE.Group();
  const bodyMaterial = new THREE.MeshStandardMaterial({ color: 0xbfc8c2, roughness: 0.62, metalness: 0.04 });
  const wingMaterial = new THREE.MeshStandardMaterial({ color: 0xd7ded7, roughness: 0.7, side: THREE.DoubleSide });
  const accentMaterial = new THREE.MeshStandardMaterial({ color: 0x1fb6a8, roughness: 0.52 });
  const darkMaterial = new THREE.MeshStandardMaterial({ color: 0x11171c, roughness: 0.64 });

  const fuselage = new THREE.Mesh(new THREE.CapsuleGeometry(0.09, 0.82, 10, 22), bodyMaterial);
  fuselage.rotation.x = Math.PI / 2;
  group.add(fuselage);

  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.092, 0.18, 24), accentMaterial);
  nose.rotation.x = Math.PI / 2;
  nose.position.z = 0.52;
  group.add(nose);

  const wing = new THREE.Mesh(makeWingGeometry(1.45, 0.22, 0.11), wingMaterial);
  wing.position.z = 0.03;
  wing.rotation.x = -0.035;
  group.add(wing);

  const tailWing = new THREE.Mesh(makeWingGeometry(0.52, 0.12, 0.07), wingMaterial);
  tailWing.position.z = -0.47;
  tailWing.position.y = 0.025;
  group.add(tailWing);

  const engine = new THREE.Mesh(new THREE.CylinderGeometry(0.076, 0.076, 0.16, 24), darkMaterial);
  engine.rotation.x = Math.PI / 2;
  engine.position.z = 0.64;
  group.add(engine);

  const propShaft = new THREE.Mesh(new THREE.CylinderGeometry(0.023, 0.023, 0.15, 16), darkMaterial);
  propShaft.rotation.x = Math.PI / 2;
  propShaft.position.z = 0.76;
  group.add(propShaft);

  const fin = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.28, 0.12), accentMaterial);
  fin.position.z = -0.42;
  fin.position.y = 0.16;
  group.add(fin);

  const prop = new THREE.Group();
  const propBladeA = new THREE.Mesh(new THREE.BoxGeometry(0.028, 0.52, 0.014), darkMaterial);
  const propBladeB = new THREE.Mesh(new THREE.BoxGeometry(0.028, 0.52, 0.014), darkMaterial);
  propBladeB.rotation.z = Math.PI / 2;
  const propHub = new THREE.Mesh(new THREE.SphereGeometry(0.055, 18, 12), darkMaterial);
  prop.add(propBladeA, propBladeB, propHub);
  prop.position.z = 0.86;
  group.add(prop);

  group.scale.setScalar(0.52);
  return { group, prop };
}

export function FlightPreview3D({
  result,
  replayState,
  replaySpeedMultiplier,
  isReplayPaused,
  onReplayChange,
  theme,
}: FlightPreview3DProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const replayControlRef = useRef({ replaySpeedMultiplier, isReplayPaused });
  const sceneRef = useRef<THREE.Scene | null>(null);
  const horizonRef = useRef<THREE.Mesh | null>(null);
  const ambientRef = useRef<THREE.HemisphereLight | null>(null);
  const themeRef = useRef(theme);

  useEffect(() => { themeRef.current = theme; }, [theme]);

  useEffect(() => {
    replayControlRef.current = { replaySpeedMultiplier, isReplayPaused };
  }, [isReplayPaused, replaySpeedMultiplier]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const primaryPath = result.truthAvailable && result.truthPath.length > 1 ? result.truthPath : result.estimatedPath;
    if (primaryPath.length < 2) return;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.95;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x071018);
    scene.fog = new THREE.FogExp2(0x071018, 0.055);
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 120);
    camera.position.set(-6, 7.5, 10);

    const ambient = new THREE.HemisphereLight(0xc8f7e7, 0x17231c, 1.75);
    ambientRef.current = ambient;
    scene.add(ambient);
    const sun = new THREE.DirectionalLight(0xf8fff4, 2.35);
    sun.position.set(-5, 9, 6);
    scene.add(sun);

    const horizonMesh = makeHorizonPlane();
    horizonRef.current = horizonMesh;
    scene.add(horizonMesh);
    applyTheme3D(resolveTheme(themeRef.current) === "light", scene, horizonMesh, ambient);

    let terrainTexture: THREE.Texture = makeTerrainTexture();
    let disposed = false;
    const terrainMesh = makeTerrainMesh(terrainTexture);
    terrainMesh.scale.set(1.28, 1, 1.22);
    const terrainMaterial = terrainMesh.material as THREE.MeshStandardMaterial;
    scene.add(terrainMesh);

    void makeSatelliteTexture()
      .then((satelliteTexture) => {
        if (disposed) {
          satelliteTexture.dispose();
          return;
        }
        terrainTexture.dispose();
        terrainTexture = satelliteTexture;
        terrainMaterial.map = satelliteTexture;
        terrainMaterial.color.set(0xffffff);
        terrainMaterial.needsUpdate = true;
      })
      .catch(() => {
        // Сеть для тайлов может отсутствовать на защите; fallback уже установлен.
      });

    const truthRoute = buildReplayRoute(primaryPath);
    const estimateRoute = buildReplayRoute(result.estimatedPath);
    const replayCurve = new THREE.CatmullRomCurve3(truthRoute, false, "centripetal", 0.42);
    const routeGroundMaxY = Math.max(...truthRoute.map((point) => point.y));
    const replayRealDurationS = routeLengthM(primaryPath) / Math.max(1, result.best.speedMps);
    const cruiseY =
      routeGroundMaxY +
      clamp(((result.config.baroAltitudeM - COPERNICUS_TAIGA_DEM.minElevationM) / 1000) * 0.72, 0.95, 1.55);
    scene.add(makeRouteRibbon(truthRoute));
    scene.add(makeRouteTube(truthRoute, 0x47d7ff, 0.012, 0.82));
    if (result.truthAvailable) {
      scene.add(makeRouteTube(estimateRoute, 0x7cff9e, 0.01, 0.58));
    }

    const startMarker = new THREE.Mesh(
      new THREE.RingGeometry(0.11, 0.16, 24),
      new THREE.MeshBasicMaterial({ color: 0xdffff8, side: THREE.DoubleSide }),
    );
    startMarker.position.copy(truthRoute[0]).add(new THREE.Vector3(0, 0.03, 0));
    startMarker.rotation.x = -Math.PI / 2;
    scene.add(startMarker);

    const finishMarker = startMarker.clone();
    finishMarker.position.copy(truthRoute[truthRoute.length - 1]).add(new THREE.Vector3(0, 0.03, 0));
    scene.add(finishMarker);

    const { group: drone, prop } = makeDrone();
    scene.add(drone);

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      renderer.setSize(Math.max(1, rect.width), Math.max(1, rect.height), false);
      camera.aspect = Math.max(1, rect.width) / Math.max(1, rect.height);
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();

    let lastFrameMs = performance.now();
    let replayElapsedS = 0;
    let visualElapsedS = 0;
    let raf = 0;
    const orientationProbe = new THREE.Object3D();
    let orientationInitialized = false;
    let lastReplayEmitS = -1;

    const animate = () => {
      const now = performance.now();
      const deltaS = Math.min(0.08, (now - lastFrameMs) / 1000);
      lastFrameMs = now;
      const controls = replayControlRef.current;
      if (!controls.isReplayPaused) {
        replayElapsedS = (replayElapsedS + deltaS * controls.replaySpeedMultiplier) % replayRealDurationS;
        visualElapsedS += deltaS;
      }
      const t = replayElapsedS / replayRealDurationS;
      const pointIndex = Math.min(primaryPath.length - 1, Math.max(0, Math.round(t * (primaryPath.length - 1))));
      const baseGround = routePosition(replayCurve, t);
      const aheadGround = routePosition(replayCurve, Math.min(0.999, t + 0.006));
      const tangent = aheadGround.clone().sub(baseGround);
      tangent.y = 0;
      tangent.normalize();
      const futureTangent = replayCurve.getTangentAt(Math.min(0.999, t + 0.03));
      futureTangent.y = 0;
      futureTangent.normalize();
      const signedTurn = Math.atan2(
        tangent.x * futureTangent.z - tangent.z * futureTangent.x,
        tangent.x * futureTangent.x + tangent.z * futureTangent.z,
      );
      const bank = clamp(-signedTurn * 4.8, -0.34, 0.34);
      const turbulenceY = Math.sin(visualElapsedS * 0.63) * 0.012 + Math.sin(visualElapsedS * 1.17) * 0.006;
      const base = new THREE.Vector3(baseGround.x, cruiseY + turbulenceY, baseGround.z);
      const ahead = new THREE.Vector3(aheadGround.x, cruiseY, aheadGround.z);

      drone.position.copy(base);
      orientationProbe.position.copy(base);
      orientationProbe.lookAt(ahead);
      orientationProbe.rotateZ(bank);
      if (!orientationInitialized) {
        drone.quaternion.copy(orientationProbe.quaternion);
        orientationInitialized = true;
      } else {
        drone.quaternion.slerp(orientationProbe.quaternion, 0.14);
      }
      if (!controls.isReplayPaused) {
        prop.rotation.z += deltaS * 86;
      }
      if (!controls.isReplayPaused && (visualElapsedS - lastReplayEmitS > 0.24 || t < 0.01)) {
        const sample = result.samples[pointIndex];
        const pathPoint = primaryPath[pointIndex];
        onReplayChange({
          pointIndex,
          elapsedS: pathPoint?.t ?? t * replayRealDurationS,
          progress: t,
          aglM: sample ? sample.radioAltitudeM : result.config.baroAltitudeM - (pathPoint?.elevationM ?? 0),
        });
        lastReplayEmitS = visualElapsedS;
      }

      const side = new THREE.Vector3().crossVectors(tangent, new THREE.Vector3(0, 1, 0)).normalize();
      const cameraTarget = drone.position
        .clone()
        .sub(tangent.clone().multiplyScalar(4.2))
        .add(side.multiplyScalar(1.25))
        .add(new THREE.Vector3(0, 2.15, 0));
      camera.position.lerp(cameraTarget, 0.045);
      camera.lookAt(drone.position.clone().add(tangent.clone().multiplyScalar(2.8)).add(new THREE.Vector3(0, -0.38, 0)));

      renderer.render(scene, camera);
      raf = requestAnimationFrame(animate);
    };
    animate();

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      observer.disconnect();
      sceneRef.current = null;
      horizonRef.current = null;
      ambientRef.current = null;
      scene.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const material = mesh.material;
        if (Array.isArray(material)) material.forEach((item) => item.dispose());
        else if (material) material.dispose();
      });
      terrainTexture.dispose();
      renderer.dispose();
    };
  }, [onReplayChange, result]);

  useEffect(() => {
    const isLight = resolveTheme(theme) === "light";
    if (sceneRef.current) {
      applyTheme3D(isLight, sceneRef.current, horizonRef.current, ambientRef.current);
    }
  }, [theme]);

  const primaryPath = result.truthAvailable && result.truthPath.length > 1 ? result.truthPath : result.estimatedPath;
  const fallbackPoint = primaryPath[0];
  const agl = replayState?.aglM ?? (result.samples[0]?.radioAltitudeM ?? result.config.baroAltitudeM - fallbackPoint.elevationM);
  const replayDurationMin = Math.round(routeLengthM(primaryPath) / Math.max(1, result.best.speedMps) / 60);

  return (
    <section className="panel flight3d-panel">
      <header>
        <div>
          <span>Реконструкция полёта</span>
          <h3>БВС над спутниковой тайгой</h3>
        </div>
        <strong>{Math.round(agl)} м AGL</strong>
      </header>
      <div className="flight3d-stage">
        <canvas ref={canvasRef} data-testid="flight-preview-3d" />
        <div className="flight3d-hud">
          <span>БАРО MSL {Math.round(result.config.baroAltitudeM)} м</span>
          <span>РВ AGL {Math.round(agl)} м</span>
          <span>Vпут {result.best.speedMps.toFixed(1)} м/с</span>
          <span>Источник {result.truthAvailable ? "стенд" : "NMEA"}</span>
          <span>T+ {Math.round(replayState?.elapsedS ?? 0)} с</span>
          <span>{isReplayPaused ? "Пауза" : `Прокрутка x${replaySpeedMultiplier}`} · {replayDurationMin} мин</span>
        </div>
      </div>
    </section>
  );
}
