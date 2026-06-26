import {
  buildGgaRadioSentence,
  nmeaChecksum,
  parseGgaRadioSentence,
  parseNmeaStream,
} from "./nmeaRadioAltimeter";
import { readFileSync } from "node:fs";
import {
  DEFAULT_MATCHER_CONFIG,
  TAIGA_ROUTE,
  localPointToWgs84,
  routeLengthM,
  runTerrainMatching,
  solveFromMeasuredProfile,
  solveFromNmea,
} from "./terrainMatcher";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function angleError(a: number, b: number): number {
  return Math.abs(((a - b + 540) % 360) - 180);
}

function run() {
  const caseSample = parseGgaRadioSentence("$GPGGA,123519.111,,,,,,,,545.4,M,46.9,M,,*47", 1500);
  assert(caseSample.radioAltitudeM === 545.4, "parser should accept the GGA shape from the case statement");
  assert(
    nmeaChecksum("GPGGA,123519.111,,,,,,,,545.4,M,46.9,M,,") === "7F",
    "checksum helper should calculate XOR checksum for the exact payload",
  );

  const sentence = buildGgaRadioSentence(12.5, 545.4);
  const parsed = parseGgaRadioSentence(sentence, 1500);
  assert(parsed.checksumOk, "generated NMEA sentence should pass checksum");
  assert(parsed.radioAltitudeM === 545.4, "parser should read radio altitude from GGA altitude field");
  assert(Math.abs(parsed.terrainMslM - 954.6) < 0.0001, "baro - radio altitude should produce terrain MSL profile");

  const stream = parseNmeaStream(`${sentence}\n${buildGgaRadioSentence(13, 546.2)}`, 1500);
  assert(stream.length === 2, "NMEA stream parser should return every sentence");

  const taiga = runTerrainMatching(DEFAULT_MATCHER_CONFIG);
  assert(TAIGA_ROUTE.start.lat > 59 && TAIGA_ROUTE.start.lon > 100, "demo route should be georeferenced in Siberian taiga");
  assert(taiga.nmea.length === taiga.samples.length, "matcher should keep NMEA and parsed sample counts aligned");
  assert(taiga.heatmap.length === 360 * 31, "matcher should evaluate every azimuth and configured speed");
  assert(routeLengthM(taiga.truthPath) > 180_000, "default route should be a long cargo-flight section");
  assert(angleError(taiga.best.azimuthDeg, DEFAULT_MATCHER_CONFIG.trueAzimuthDeg) <= 2, "terrain correlation should recover azimuth on taiga route");
  assert(Math.abs(taiga.best.speedMps - DEFAULT_MATCHER_CONFIG.trueSpeedMps) <= 1, "terrain correlation should recover speed on taiga route");
  assert(taiga.best.correlation > 0.98, "best candidate should have high correlation on taiga profile");
  assert(taiga.finalErrorM !== null, "simulation should expose final coordinate error");
  assert(taiga.finalErrorM < 2000, "final coordinate error should stay bounded in the deterministic stand");
  assert(taiga.best.confidence >= 70, "taiga route should produce useful confidence");

  const finish = localPointToWgs84(taiga.estimatedPath[taiga.estimatedPath.length - 1]);
  assert(finish.lat > TAIGA_ROUTE.start.lat, "default route should move north-east from Vanavara");
  assert(finish.lon > TAIGA_ROUTE.start.lon, "default route should move east from Vanavara");

  const imported = solveFromNmea(taiga.nmea.join("\n"), {
    terrainKind: DEFAULT_MATCHER_CONFIG.terrainKind,
    baroAltitudeM: DEFAULT_MATCHER_CONFIG.baroAltitudeM,
    sampleRateHz: DEFAULT_MATCHER_CONFIG.sampleRateHz,
    speedMinMps: DEFAULT_MATCHER_CONFIG.speedMinMps,
    speedMaxMps: DEFAULT_MATCHER_CONFIG.speedMaxMps,
    speedStepMps: DEFAULT_MATCHER_CONFIG.speedStepMps,
  });
  assert(!imported.truthAvailable, "NMEA solver should not require truthPath");
  assert(imported.truthPath.length === 0, "imported NMEA result must not carry synthetic truthPath");
  assert(imported.estimatedPath.length === imported.samples.length, "imported/raw NMEA path should return an estimated path");
  assert(angleError(imported.best.azimuthDeg, DEFAULT_MATCHER_CONFIG.trueAzimuthDeg) <= 2, "solver should recover azimuth from raw NMEA");
  assert(Math.abs(imported.best.speedMps - DEFAULT_MATCHER_CONFIG.trueSpeedMps) <= 1, "solver should recover speed from raw NMEA");
  assert(imported.finalErrorM === null && imported.speedErrorMps === null, "truth metrics should be unavailable for imported logs");
  assert(imported.events[0]?.code === "RA_STREAM_STARTED", "solver should emit an event log from the current calculation");
  assert(imported.events.some((event) => event.code === "BEST_CANDIDATE"), "solver should log the selected best candidate");
  assert(imported.autopilotOutput.courseCorrectionDeg === null, "course correction should be explicit when not configured");
  assert(imported.autopilotOutput.confidence > 0.7, "autopilot output should carry normalized confidence");

  const px4ExternalNmea = readFileSync("examples/px4-derived-radio-altimeter.nmea", "utf8");
  const px4Imported = solveFromNmea(px4ExternalNmea, {
    terrainKind: DEFAULT_MATCHER_CONFIG.terrainKind,
    baroAltitudeM: DEFAULT_MATCHER_CONFIG.baroAltitudeM,
    sampleRateHz: DEFAULT_MATCHER_CONFIG.sampleRateHz,
    speedMinMps: DEFAULT_MATCHER_CONFIG.speedMinMps,
    speedMaxMps: DEFAULT_MATCHER_CONFIG.speedMaxMps,
    speedStepMps: DEFAULT_MATCHER_CONFIG.speedStepMps,
  });
  assert(!px4Imported.truthAvailable, "PX4-derived external NMEA file should solve without truth");
  assert(px4Imported.samples.length === 1690, "PX4-derived external NMEA fixture should keep every imported sentence");
  assert(px4Imported.events.some((event) => event.code === "RA_STREAM_STARTED"), "PX4-derived import should produce algorithm events");
  assert(px4Imported.autopilotOutput.courseCorrectionDeg === null, "PX4-derived import should not invent course correction");

  const flat = runTerrainMatching({
    ...DEFAULT_MATCHER_CONFIG,
    terrainKind: "flat",
    radioNoiseM: 10,
  });
  assert(flat.best.confidence < taiga.best.confidence, "flat noisy terrain should reduce self-estimated confidence");
  assert(flat.navigationStatus !== "FIX VALID", "flat or low-informative terrain should degrade navigation status");

  const noFix = solveFromMeasuredProfile({
    config: {
      terrainKind: "taiga",
      baroAltitudeM: DEFAULT_MATCHER_CONFIG.baroAltitudeM,
      sampleRateHz: DEFAULT_MATCHER_CONFIG.sampleRateHz,
      speedMinMps: DEFAULT_MATCHER_CONFIG.speedMinMps,
      speedMaxMps: DEFAULT_MATCHER_CONFIG.speedMaxMps,
      speedStepMps: DEFAULT_MATCHER_CONFIG.speedStepMps,
    },
    measuredProfile: Array.from({ length: 96 }, (_, index) => (index % 2 === 0 ? 980 : -120)),
  });
  assert(noFix.navigationStatus === "NO FIX", "unmatched high-energy profile should produce NO FIX");
  assert(noFix.autopilotOutput.uncertaintyM === null, "NO FIX should not expose a fake uncertainty radius");

  console.log("Smoke tests passed: NMEA radio altimeter, taiga route, terrain correlation, map estimate");
}

run();
