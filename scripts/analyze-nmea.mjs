import * as esbuild from "esbuild";
import { mkdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const tempDir = path.join(root, ".tmp");
const outfile = path.join(tempDir, "analyze-nmea.mjs");

function usage() {
  console.log(`Usage:
  npm run nmea:analyze -- <file.nmea|file.txt|file.log> [options]

Options:
  --json                 print JSON only
  --baro <m>             barometric altitude MSL, default 1500
  --sample-rate <hz>     fallback sample rate, default 2
  --speed-min <mps>      search min speed, default 35
  --speed-max <mps>      search max speed, default 55
  --speed-step <mps>     speed step, default 1
  --planned-azimuth <°>  planned route azimuth for course correction, default 73
  --lookahead <m>        route lookahead for course correction, default 2500
`);
}

function readOption(args, name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`Missing value for ${name}`);
  }
  return value;
}

function readNumberOption(args, name, fallback) {
  const raw = readOption(args, name, String(fallback));
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`Invalid numeric value for ${name}: ${raw}`);
  return value;
}

function readSourceFile(args) {
  const optionsWithValues = new Set([
    "--baro",
    "--sample-rate",
    "--speed-min",
    "--speed-max",
    "--speed-step",
    "--planned-azimuth",
    "--lookahead",
  ]);

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (optionsWithValues.has(arg)) {
      index += 1;
      continue;
    }
    if (!arg.startsWith("--")) return arg;
  }

  return null;
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  usage();
  process.exit(0);
}

const sourceFile = readSourceFile(args);
if (!sourceFile) {
  usage();
  process.exit(1);
}

const request = {
  file: path.resolve(root, sourceFile),
  json: args.includes("--json"),
  baroAltitudeM: readNumberOption(args, "--baro", 1500),
  sampleRateHz: readNumberOption(args, "--sample-rate", 2),
  speedMinMps: readNumberOption(args, "--speed-min", 35),
  speedMaxMps: readNumberOption(args, "--speed-max", 55),
  speedStepMps: readNumberOption(args, "--speed-step", 1),
  plannedAzimuthDeg: readNumberOption(args, "--planned-azimuth", 73),
  courseLookaheadM: readNumberOption(args, "--lookahead", 2500),
};

const runnerSource = `
import { readFileSync } from "node:fs";
import { COPERNICUS_TAIGA_DEM } from "./src/copernicusDemSample.ts";
import { localPointToWgs84, routeLengthM, solveFromNmea } from "./src/terrainMatcher.ts";

const request = JSON.parse(process.argv[2]);
const text = readFileSync(request.file, "utf8");
const result = solveFromNmea(text, {
  terrainKind: "taiga",
  baroAltitudeM: request.baroAltitudeM,
  sampleRateHz: request.sampleRateHz,
  speedMinMps: request.speedMinMps,
  speedMaxMps: request.speedMaxMps,
  speedStepMps: request.speedStepMps,
  plannedAzimuthDeg: request.plannedAzimuthDeg,
  courseLookaheadM: request.courseLookaheadM,
});
const finalPoint = result.estimatedPath[result.estimatedPath.length - 1];
const finalWgs84 = finalPoint ? localPointToWgs84(finalPoint) : null;
const fixUsable = result.autopilotOutput.fixUsable;
const bestCandidate = {
  local_x_m: Math.round(result.autopilotOutput.localXM),
  local_y_m: Math.round(result.autopilotOutput.localYM),
  lat: finalWgs84 ? Number(finalWgs84.lat.toFixed(6)) : null,
  lon: finalWgs84 ? Number(finalWgs84.lon.toFixed(6)) : null,
  ground_speed_mps: result.autopilotOutput.groundSpeedMps,
  azimuth_deg: result.autopilotOutput.azimuthDeg,
};
const output = {
  source_file: request.file,
  truth: "unavailable",
  fix_usable: fixUsable,
  navigation_status: result.navigationStatus,
  status_reason: result.statusReason,
  samples: result.samples.length,
  route_length_m: fixUsable ? Math.round(routeLengthM(result.estimatedPath)) : null,
  diagnostic_route_length_m: Math.round(routeLengthM(result.estimatedPath)),
  best_corr: Number(result.best.correlation.toFixed(4)),
  second_corr: result.secondCorrelation === null ? null : Number(result.secondCorrelation.toFixed(4)),
  ambiguity_margin: Number(result.ambiguity.toFixed(4)),
  profile_rmse_m: Math.round(result.best.rmseM),
  confidence: result.autopilotOutput.confidence,
  terrain_std_m: Number(result.terrainStdM.toFixed(1)),
  compute_ms: Math.round(result.computeMs),
  local_x_m: fixUsable ? bestCandidate.local_x_m : null,
  local_y_m: fixUsable ? bestCandidate.local_y_m : null,
  lat: fixUsable ? bestCandidate.lat : null,
  lon: fixUsable ? bestCandidate.lon : null,
  ground_speed_mps: fixUsable ? bestCandidate.ground_speed_mps : null,
  azimuth_deg: fixUsable ? bestCandidate.azimuth_deg : null,
  uncertainty_m: result.autopilotOutput.uncertaintyM,
  course_correction_deg: result.autopilotOutput.courseCorrectionDeg,
  best_candidate: bestCandidate,
  nmea_quality: result.nmeaQuality,
  dem: {
    source_name: COPERNICUS_TAIGA_DEM.sourceName,
    region: COPERNICUS_TAIGA_DEM.region,
    generated_at: COPERNICUS_TAIGA_DEM.generatedAt,
    grid: {
      width: COPERNICUS_TAIGA_DEM.width,
      height: COPERNICUS_TAIGA_DEM.height
    },
    bounds: COPERNICUS_TAIGA_DEM.bounds,
    elevation_range_m: {
      min: COPERNICUS_TAIGA_DEM.minElevationM,
      max: COPERNICUS_TAIGA_DEM.maxElevationM
    }
  },
  events: result.events.map((event) => ({
    code: event.code,
    elapsed_ms: event.elapsedMs
  })),
};

if (request.json) {
  console.log(JSON.stringify(output, null, 2));
} else {
  console.log("КРОТ: анализ NMEA");
  console.log("----------------------------------------");
  console.log(\`файл: \${output.source_file}\`);
  console.log(\`истинная траектория: \${output.truth === "unavailable" ? "не передана" : output.truth}\`);
  console.log(\`статус: \${output.navigation_status}\`);
  console.log(\`причина: \${output.status_reason}\`);
  console.log(\`строк NMEA: \${output.samples}\`);
  console.log(\`совпадение: \${output.best_corr} / второй пик \${output.second_corr}\`);
  console.log(\`зазор: \${output.ambiguity_margin}\`);
  console.log(\`ошибка профиля: \${output.profile_rmse_m} м\`);
  console.log(\`доверие к расчёту: \${output.confidence}\`);
  console.log(\`время расчёта: \${output.compute_ms} мс\`);
  console.log(\`навигационная выдача: \${output.fix_usable ? "доступна" : "не выдана"}\`);
  if (output.fix_usable) {
    console.log(\`локально: X \${output.local_x_m} м / Y \${output.local_y_m} м\`);
    console.log(\`wgs84: \${output.lat}, \${output.lon}\`);
    console.log(\`Vпут: \${output.ground_speed_mps} м/с\`);
    console.log(\`азимут: \${output.azimuth_deg}°\`);
  } else {
    console.log(\`диагностический кандидат: X \${output.best_candidate.local_x_m} м / Y \${output.best_candidate.local_y_m} м / \${output.best_candidate.ground_speed_mps} м/с / \${output.best_candidate.azimuth_deg}°\`);
  }
  console.log(\`поправка курса: \${output.course_correction_deg === null ? "н/д" : output.course_correction_deg + "°"}\`);
  console.log(\`карта высот: \${output.dem.source_name} / \${output.dem.grid.width}x\${output.dem.grid.height}\`);
}
`;

await rm(tempDir, { recursive: true, force: true });
await mkdir(tempDir, { recursive: true });

await esbuild.build({
  stdin: {
    contents: runnerSource,
    resolveDir: root,
    sourcefile: "analyze-nmea-runner.ts",
    loader: "ts",
  },
  bundle: true,
  outfile,
  platform: "node",
  format: "esm",
  logLevel: "silent",
});

const result = spawnSync(process.execPath, [outfile, JSON.stringify(request)], { stdio: "inherit" });
await rm(tempDir, { recursive: true, force: true });
process.exit(result.status ?? 1);
