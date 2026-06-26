import { useEffect, useRef } from "react";
import * as THREE from "three";
import { TerrainMatchResult } from "./terrainMatcher";

type FlightPreview3DProps = {
  result: TerrainMatchResult;
};

function terrainHeight(x: number, z: number) {
  return (
    Math.sin(x * 0.9) * 0.28 +
    Math.cos(z * 1.15) * 0.22 +
    Math.sin((x + z) * 0.55) * 0.18 -
    0.35
  );
}

function makeDrone() {
  const group = new THREE.Group();
  const bodyMaterial = new THREE.MeshStandardMaterial({ color: 0xd8e3dc, roughness: 0.42, metalness: 0.12 });
  const accentMaterial = new THREE.MeshStandardMaterial({ color: 0x38d9c4, roughness: 0.34, metalness: 0.18 });
  const darkMaterial = new THREE.MeshStandardMaterial({ color: 0x121b22, roughness: 0.5 });

  const fuselage = new THREE.Mesh(new THREE.CapsuleGeometry(0.13, 1.18, 8, 18), bodyMaterial);
  fuselage.rotation.x = Math.PI / 2;
  group.add(fuselage);

  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.28, 20), accentMaterial);
  nose.rotation.x = Math.PI / 2;
  nose.position.z = -0.75;
  group.add(nose);

  const wing = new THREE.Mesh(new THREE.BoxGeometry(2.25, 0.035, 0.22), bodyMaterial);
  wing.position.z = -0.08;
  group.add(wing);

  const tailWing = new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.03, 0.14), bodyMaterial);
  tailWing.position.z = 0.67;
  tailWing.position.y = 0.03;
  group.add(tailWing);

  const fin = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.46, 0.18), accentMaterial);
  fin.position.z = 0.56;
  fin.position.y = 0.22;
  group.add(fin);

  const prop = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.56, 0.025), darkMaterial);
  prop.position.z = -0.91;
  group.add(prop);

  group.scale.setScalar(0.9);
  return { group, prop };
}

export function FlightPreview3D({ result }: FlightPreview3DProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x071018);
    scene.fog = new THREE.Fog(0x071018, 9, 26);

    const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 100);
    camera.position.set(0, 4.2, 7.5);

    const hemi = new THREE.HemisphereLight(0xd7fff4, 0x17381f, 2.2);
    scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xffffff, 2.5);
    sun.position.set(-5, 8, 5);
    scene.add(sun);

    const terrain = new THREE.PlaneGeometry(24, 14, 96, 56);
    terrain.rotateX(-Math.PI / 2);
    const colors: number[] = [];
    const position = terrain.getAttribute("position") as THREE.BufferAttribute;
    for (let i = 0; i < position.count; i += 1) {
      const x = position.getX(i);
      const z = position.getZ(i);
      const h = terrainHeight(x, z);
      position.setY(i, h);
      const color = new THREE.Color();
      color.setHSL(0.31 + h * 0.025, 0.48, 0.25 + h * 0.05);
      colors.push(color.r, color.g, color.b);
    }
    terrain.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    terrain.computeVertexNormals();
    const terrainMesh = new THREE.Mesh(
      terrain,
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 }),
    );
    scene.add(terrainMesh);

    const riverCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(-12, -0.22, 2.5),
      new THREE.Vector3(-7, -0.28, 1.1),
      new THREE.Vector3(-2, -0.3, 1.7),
      new THREE.Vector3(4, -0.26, -0.2),
      new THREE.Vector3(12, -0.22, -1.8),
    ]);
    const river = new THREE.Mesh(
      new THREE.TubeGeometry(riverCurve, 64, 0.08, 8, false),
      new THREE.MeshStandardMaterial({ color: 0x0a5d75, emissive: 0x042635, roughness: 0.52 }),
    );
    scene.add(river);

    const trunkGeometry = new THREE.CylinderGeometry(0.025, 0.035, 0.22, 5);
    const crownGeometry = new THREE.ConeGeometry(0.12, 0.42, 6);
    const trunkMesh = new THREE.InstancedMesh(trunkGeometry, new THREE.MeshStandardMaterial({ color: 0x4d3424 }), 150);
    const crownMesh = new THREE.InstancedMesh(crownGeometry, new THREE.MeshStandardMaterial({ color: 0x0e5a32, roughness: 0.84 }), 150);
    const matrix = new THREE.Matrix4();
    for (let i = 0; i < 150; i += 1) {
      const x = ((Math.sin(i * 17.17) * 0.5 + 0.5) * 22) - 11;
      const z = ((Math.sin(i * 31.91 + 2.4) * 0.5 + 0.5) * 12) - 6;
      const y = terrainHeight(x, z);
      matrix.makeTranslation(x, y + 0.11, z);
      trunkMesh.setMatrixAt(i, matrix);
      matrix.makeTranslation(x, y + 0.42, z);
      crownMesh.setMatrixAt(i, matrix);
    }
    scene.add(trunkMesh, crownMesh);

    const routeMaterial = new THREE.LineBasicMaterial({ color: 0x55e6ff, linewidth: 2 });
    const routePoints = Array.from({ length: 80 }, (_, i) => {
      const t = i / 79;
      const x = -9 + t * 18;
      const z = 3.8 - t * 6.4;
      return new THREE.Vector3(x, terrainHeight(x, z) + 1.35, z);
    });
    scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(routePoints), routeMaterial));

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

    let frame = 0;
    let raf = 0;
    const animate = () => {
      frame += 1;
      const t = (frame % 720) / 720;
      const x = -8.3 + t * 16.6;
      const z = 3.3 - t * 5.8;
      const ground = terrainHeight(x, z);
      const y = ground + 1.72 + Math.sin(t * Math.PI * 2) * 0.08;
      drone.position.set(x, y, z);
      drone.rotation.set(-0.08 + Math.sin(t * Math.PI * 2) * 0.04, Math.PI / 2.85, Math.sin(t * Math.PI * 2) * 0.15);
      prop.rotation.z += 0.75;
      camera.position.lerp(new THREE.Vector3(x - 3.2, y + 1.45, z + 4.2), 0.04);
      camera.lookAt(x + 1.2, y - 0.2, z - 0.7);
      renderer.render(scene, camera);
      raf = requestAnimationFrame(animate);
    };
    animate();

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      terrain.dispose();
      renderer.dispose();
      scene.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const material = mesh.material;
        if (Array.isArray(material)) material.forEach((item) => item.dispose());
        else if (material) material.dispose();
      });
    };
  }, [result.config.baroAltitudeM, result.config.trueAzimuthDeg, result.config.trueSpeedMps]);

  const last = result.truthPath[result.truthPath.length - 1];
  const agl = result.config.baroAltitudeM - last.elevationM;

  return (
    <section className="panel flight3d-panel">
      <header>
        <div>
          <span>Профиль полёта</span>
          <h3>3D-превью БВС</h3>
        </div>
        <strong>{Math.round(agl)} м AGL</strong>
      </header>
      <div className="flight3d-stage">
        <canvas ref={canvasRef} data-testid="flight-preview-3d" />
        <div className="flight3d-hud">
          <span>БАРО MSL {Math.round(result.config.baroAltitudeM)} м</span>
          <span>РВ AGL {Math.round(agl)} м</span>
          <span>Vпут {result.best.speedMps.toFixed(1)} м/с</span>
        </div>
      </div>
    </section>
  );
}
