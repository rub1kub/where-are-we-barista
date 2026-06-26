import { useEffect, useRef } from "react";
import * as THREE from "three";
import { COPERNICUS_TAIGA_DEM } from "./copernicusDemSample";
import { MatchPoint, TerrainMatchResult, localPointToWgs84 } from "./terrainMatcher";

type FlightPreview3DProps = {
  result: TerrainMatchResult;
};

const SCENE_WIDTH = 28;
const SCENE_DEPTH = 11.2;
const TERRAIN_SEGMENTS_X = 180;
const TERRAIN_SEGMENTS_Z = 72;
const TEXTURE_WIDTH = 1024;
const TEXTURE_HEIGHT = 512;

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

function elevationToSceneY(elevationM: number): number {
  const min = COPERNICUS_TAIGA_DEM.minElevationM;
  const max = COPERNICUS_TAIGA_DEM.maxElevationM;
  return ((elevationM - min) / Math.max(1, max - min) - 0.46) * 2.35;
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
  return elevationToSceneY(sampleDemLatLon(lat, lon));
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

function pointToScene(point: MatchPoint, clearance = 0.05): THREE.Vector3 {
  const wgs = localPointToWgs84(point);
  const scenePoint = wgsToScene(wgs.lat, wgs.lon, point.elevationM);
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
  nose.position.z = -0.52;
  group.add(nose);

  const wing = new THREE.Mesh(makeWingGeometry(1.45, 0.22, 0.11), wingMaterial);
  wing.position.z = -0.03;
  wing.rotation.x = -0.035;
  group.add(wing);

  const tailWing = new THREE.Mesh(makeWingGeometry(0.52, 0.12, 0.07), wingMaterial);
  tailWing.position.z = 0.47;
  tailWing.position.y = 0.025;
  group.add(tailWing);

  const fin = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.28, 0.12), accentMaterial);
  fin.position.z = 0.42;
  fin.position.y = 0.16;
  group.add(fin);

  const prop = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.42, 0.018), darkMaterial);
  prop.position.z = -0.64;
  group.add(prop);

  group.scale.setScalar(0.52);
  return { group, prop };
}

function routePosition(route: THREE.Vector3[], t: number): THREE.Vector3 {
  const scaled = clamp(t, 0, 1) * (route.length - 1);
  const index = Math.floor(scaled);
  const nextIndex = Math.min(route.length - 1, index + 1);
  const localT = scaled - index;
  return route[index].clone().lerp(route[nextIndex], localT);
}

export function FlightPreview3D({ result }: FlightPreview3DProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.95;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x071018);
    scene.fog = new THREE.FogExp2(0x071018, 0.055);

    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 120);
    camera.position.set(-6, 7.5, 10);

    const ambient = new THREE.HemisphereLight(0xc8f7e7, 0x17231c, 1.75);
    scene.add(ambient);
    const sun = new THREE.DirectionalLight(0xf8fff4, 2.35);
    sun.position.set(-5, 9, 6);
    scene.add(sun);

    const texture = makeTerrainTexture();
    const terrainMesh = makeTerrainMesh(texture);
    scene.add(terrainMesh);

    const truthRoute = sampledPath(result.truthPath, 190);
    const estimateRoute = sampledPath(result.estimatedPath, 190);
    scene.add(makeRouteTube(truthRoute, 0x47d7ff, 0.018, 0.94));
    scene.add(makeRouteTube(estimateRoute, 0x7cff9e, 0.014, 0.76));

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

    const clock = new THREE.Clock();
    let raf = 0;

    const animate = () => {
      const elapsed = clock.getElapsedTime();
      const t = (elapsed * 0.035) % 1;
      const base = routePosition(truthRoute, t);
      const ahead = routePosition(truthRoute, Math.min(1, t + 0.012));
      const tangent = ahead.clone().sub(base).normalize();
      const groundY = terrainYAtScene(base.x, base.z);
      const aglM = Math.max(80, result.config.baroAltitudeM - result.truthPath[result.truthPath.length - 1].elevationM);
      const altitudeUnits = clamp((aglM / 1000) * 2.05, 1.18, 3.15);

      drone.position.set(base.x, groundY + altitudeUnits, base.z);
      drone.lookAt(ahead.x, groundY + altitudeUnits + tangent.y, ahead.z);
      drone.rotateZ(Math.sin(elapsed * 0.9) * 0.08);
      prop.rotation.z += 1.15;

      const side = new THREE.Vector3().crossVectors(tangent, new THREE.Vector3(0, 1, 0)).normalize();
      const cameraTarget = drone.position
        .clone()
        .sub(tangent.clone().multiplyScalar(4.6))
        .add(side.multiplyScalar(1.5))
        .add(new THREE.Vector3(0, 3.0, 0));
      camera.position.lerp(cameraTarget, 0.035);
      camera.lookAt(drone.position.clone().add(tangent.clone().multiplyScalar(2.8)).add(new THREE.Vector3(0, -0.55, 0)));

      renderer.render(scene, camera);
      raf = requestAnimationFrame(animate);
    };
    animate();

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      scene.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const material = mesh.material;
        if (Array.isArray(material)) material.forEach((item) => item.dispose());
        else if (material) material.dispose();
      });
      texture.dispose();
      renderer.dispose();
    };
  }, [result]);

  const last = result.truthPath[result.truthPath.length - 1];
  const agl = result.config.baroAltitudeM - last.elevationM;

  return (
    <section className="panel flight3d-panel">
      <header>
        <div>
          <span>Реконструкция полёта</span>
          <h3>БВС над ЦМР Copernicus</h3>
        </div>
        <strong>{Math.round(agl)} м AGL</strong>
      </header>
      <div className="flight3d-stage">
        <canvas ref={canvasRef} data-testid="flight-preview-3d" />
        <div className="flight3d-hud">
          <span>БАРО MSL {Math.round(result.config.baroAltitudeM)} м</span>
          <span>РВ AGL {Math.round(agl)} м</span>
          <span>Vпут {result.best.speedMps.toFixed(1)} м/с</span>
          <span>corr {result.best.correlation.toFixed(3)}</span>
        </div>
      </div>
    </section>
  );
}
