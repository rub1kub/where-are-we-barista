import * as esbuild from "esbuild";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const tempDir = path.join(root, ".tmp");
const entry = path.join(tempDir, "generate-control-nmea.ts");
const outfile = path.join(tempDir, "generate-control-nmea.mjs");

const runnerSource = `
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { COPERNICUS_TAIGA_DEM } from "../src/copernicusDemSample";
import {
  DEFAULT_MATCHER_CONFIG,
  TAIGA_ROUTE,
  localPointToWgs84,
  routeLengthM,
  runTerrainMatching,
  simulateFlight,
} from "../src/terrainMatcher";

const root = process.argv[2];
const examplesDir = path.join(root, "examples");
const nmeaFile = "vanavara-success-radio-altimeter.nmea";
const metaFile = "vanavara-success-radio-altimeter.meta.json";
mkdirSync(examplesDir, { recursive: true });

const config = { ...DEFAULT_MATCHER_CONFIG };
const simulation = simulateFlight(config);
const result = runTerrainMatching(config);
const finalTruth = simulation.truthPath[simulation.truthPath.length - 1];
const finalWgs84 = finalTruth ? localPointToWgs84(finalTruth) : null;

writeFileSync(path.join(examplesDir, nmeaFile), simulation.nmea.join("\\n") + "\\n", "utf8");

const meta = {
  schemaVersion: "1.0",
  file: nmeaFile,
  kind: "synthetic control log",
  purpose: "Successful external NMEA fixture for post-flight mode without passing truthPath into solver.",
  warning: "This is not customer data. Truth is used only to generate and document this fixture, not as solver input.",
  region: TAIGA_ROUTE.region,
  routeName: TAIGA_ROUTE.routeName,
  dem: {
    sourceName: COPERNICUS_TAIGA_DEM.sourceName,
    region: COPERNICUS_TAIGA_DEM.region,
    generatedAt: COPERNICUS_TAIGA_DEM.generatedAt,
    bounds: COPERNICUS_TAIGA_DEM.bounds,
    width: COPERNICUS_TAIGA_DEM.width,
    height: COPERNICUS_TAIGA_DEM.height,
    minElevationM: COPERNICUS_TAIGA_DEM.minElevationM,
    maxElevationM: COPERNICUS_TAIGA_DEM.maxElevationM,
  },
  nmea: {
    sentence: "GPGGA",
    sampleRateHz: config.sampleRateHz,
    samples: simulation.nmea.length,
    baroAltitudeM: config.baroAltitudeM,
    radioAltitudeField: "GGA altitude field is used as RA AGL for the hackathon case format.",
    checksum: "valid XOR checksum on every sentence",
  },
  generation: {
    terrainKind: config.terrainKind,
    durationS: config.durationS,
    speedMps: config.trueSpeedMps,
    azimuthDeg: config.trueAzimuthDeg,
    radioNoiseM: config.radioNoiseM,
    expectedRouteLengthM: Math.round(routeLengthM(simulation.truthPath)),
    startWgs84: TAIGA_ROUTE.start,
    finalWgs84: finalWgs84 ? {
      lat: Number(finalWgs84.lat.toFixed(6)),
      lon: Number(finalWgs84.lon.toFixed(6)),
    } : null,
  },
  expectedSolverResult: {
    navigationStatus: result.navigationStatus,
    approximateSpeedMps: result.best.speedMps,
    approximateAzimuthDeg: result.best.azimuthDeg,
    correlation: Number(result.best.correlation.toFixed(4)),
    rmseM: Math.round(result.best.rmseM),
    confidence: Math.round(result.best.confidence),
    truthAvailableInSolver: false,
  },
};

writeFileSync(path.join(examplesDir, metaFile), JSON.stringify(meta, null, 2) + "\\n", "utf8");
console.log(\`Generated examples/\${nmeaFile} (\${simulation.nmea.length} sentences)\`);
console.log(\`Generated examples/\${metaFile} (\${result.navigationStatus}, corr=\${result.best.correlation.toFixed(3)})\`);
`;

await rm(tempDir, { recursive: true, force: true });
await mkdir(tempDir, { recursive: true });
await writeFile(entry, runnerSource, "utf8");

await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  outfile,
  platform: "node",
  format: "esm",
  logLevel: "silent",
});

const result = spawnSync(process.execPath, [outfile, root], { stdio: "inherit" });
await rm(tempDir, { recursive: true, force: true });
process.exit(result.status ?? 1);
