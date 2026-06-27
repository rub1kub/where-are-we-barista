import {
  buildGgaRadioSentence,
  nmeaChecksum,
  parseGgaRadioSentence,
  parseNmeaStream,
} from "./nmeaRadioAltimeter";
import { readFileSync } from "node:fs";
import {
  DEFAULT_MATCHER_CONFIG,
  FLAT_DEMO_CONFIG,
  MOUNTAIN_DEMO_CONFIG,
  TAIGA_ROUTE,
  buildAutopilotOutputAtPoint,
  classifyNavigationStatus,
  localPointToWgs84,
  routeLengthM,
  runTerrainMatching,
  solveFromMeasuredProfile,
  solveFromNmea,
} from "./terrainMatcher";
import { COPERNICUS_TAIGA_DEM } from "./copernicusDemSample";
import {
  buildCheckpointDemoText,
  buildCheckpointTrajectory,
  checkpointResultToCsv,
  createTaigaCheckpointDem,
  parseCheckpointHeights,
} from "./checkpoint3";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function angleError(a: number, b: number): number {
  return Math.abs(((a - b + 540) % 360) - 180);
}

function run() {
  const caseSample = parseGgaRadioSentence("$GPGGA,123519.111,,,,,,,,545.4,M,46.9,M,,*47", 1500);
  assert(caseSample.radioAltitudeM === 545.4, "parser should accept the GGA shape from the case statement");
  assert(caseSample.checksumStatus === "invalid", "parser should flag the case-statement checksum without rejecting the sentence");
  assert(
    nmeaChecksum("GPGGA,123519.111,,,,,,,,545.4,M,46.9,M,,") === "7F",
    "checksum helper should calculate XOR checksum for the exact payload",
  );

  const sentence = buildGgaRadioSentence(12.5, 545.4);
  const parsed = parseGgaRadioSentence(sentence, 1500);
  assert(parsed.checksumOk, "generated NMEA sentence should pass checksum");
  assert(parsed.checksumStatus === "ok", "generated NMEA sentence should expose checksum status");
  assert(parsed.radioAltitudeM === 545.4, "parser should read radio altitude from GGA altitude field");
  assert(Math.abs(parsed.terrainMslM - 954.6) < 0.0001, "baro - radio altitude should produce terrain MSL profile");

  const stream = parseNmeaStream(`${sentence}\n${buildGgaRadioSentence(13, 546.2)}`, 1500);
  assert(stream.length === 2, "NMEA stream parser should return every sentence");

  assert(COPERNICUS_TAIGA_DEM.width === 420, "height map sample should keep expected width");
  assert(COPERNICUS_TAIGA_DEM.height === 180, "height map sample should keep expected height");
  assert(
    COPERNICUS_TAIGA_DEM.elevationM.length === COPERNICUS_TAIGA_DEM.width * COPERNICUS_TAIGA_DEM.height,
    "height map sample should contain one elevation per grid point",
  );
  assert(
    COPERNICUS_TAIGA_DEM.maxElevationM - COPERNICUS_TAIGA_DEM.minElevationM > 300,
    "height map sample should have a non-zero, visible elevation range",
  );
  assert(COPERNICUS_TAIGA_DEM.sourceUrls.length >= 1, "height map sample should keep open-source provenance URLs");

  const taiga = runTerrainMatching(DEFAULT_MATCHER_CONFIG);
  assert(TAIGA_ROUTE.start.lat > 59 && TAIGA_ROUTE.start.lon > 100, "demo route should be georeferenced in Siberian taiga");
  assert(taiga.nmea.length === taiga.samples.length, "matcher should keep NMEA and parsed sample counts aligned");
  assert(taiga.heatmap.length === 360 * 31, "matcher should evaluate every azimuth and configured speed");
  assert(routeLengthM(taiga.truthPath) > 180_000, "default route should be a long cargo-flight section");
  assert(angleError(taiga.best.azimuthDeg, DEFAULT_MATCHER_CONFIG.trueAzimuthDeg) <= 2, "terrain correlation should recover azimuth on taiga route");
  assert(Math.abs(taiga.best.speedMps - DEFAULT_MATCHER_CONFIG.trueSpeedMps) <= 1, "terrain correlation should recover speed on taiga route");
  assert(taiga.best.correlation > 0.98, "best candidate should have high correlation on taiga profile");
  assert(taiga.best.shiftM === 0, "deterministic stand should recover zero route offset");
  assert(taiga.nmeaQuality.checksumInvalid === 0, "generated stand NMEA should not contain checksum failures");
  assert(taiga.finalErrorM !== null, "simulation should expose final coordinate error");
  assert(taiga.finalErrorM < 2000, "final coordinate error should stay bounded in the deterministic stand");
  assert(taiga.best.confidence >= 70, "taiga route should produce useful confidence");
  assert(taiga.autopilotOutput.fixUsable, "valid/degraded stand result should be marked usable for navigation output");
  assert(
    taiga.navigationStatus === "FIX VALID" || taiga.navigationStatus === "FIX DEGRADED",
    "Vanavara scenario should produce a usable navigation result",
  );
  assert(
    taiga.autopilotOutput.courseCorrectionDeg !== null && Math.abs(taiga.autopilotOutput.courseCorrectionDeg) <= 0.2,
    "default planned route should produce near-zero course correction",
  );

  const checkpointHeights = parseCheckpointHeights(buildCheckpointDemoText());
  const checkpointResult = buildCheckpointTrajectory({
    heightsM: checkpointHeights,
    dem: createTaigaCheckpointDem(),
    startX: 0,
    startY: 0,
    azimuthDeg: DEFAULT_MATCHER_CONFIG.trueAzimuthDeg,
    sampleDistanceM: DEFAULT_MATCHER_CONFIG.trueSpeedMps / DEFAULT_MATCHER_CONFIG.sampleRateHz,
    autoFitStep: true,
    stepMinM: 5,
    stepMaxM: 90,
  });
  assert(checkpointResult.inputSamples === checkpointHeights.length, "checkpoint TXT adapter should keep every height sample");
  assert(checkpointResult.points.length === checkpointHeights.length, "checkpoint adapter should output one coordinate per height");
  assert(checkpointResult.status === "TRAJECTORY READY", "checkpoint adapter should produce a ready trajectory on the Vanavara sample");
  assert(Math.abs(checkpointResult.sampleDistanceM - 22) <= 1, "checkpoint adapter should recover the sample distance from DEM correlation");
  assert(checkpointResult.profileRmseM !== null && checkpointResult.profileRmseM < 8, "checkpoint profile should match the DEM on the control sample");
  assert(checkpointResult.points.some((point) => point.lat !== null && point.lon !== null), "checkpoint output should include global WGS-84 where available");
  assert(
    checkpointResultToCsv(checkpointResult).startsWith("index,distance_m,local_x,local_y,lat,lon"),
    "checkpoint CSV export should include local and global coordinate columns",
  );

  const mountain = runTerrainMatching(MOUNTAIN_DEMO_CONFIG);
  assert(
    mountain.navigationStatus === "FIX VALID" || mountain.navigationStatus === "FIX DEGRADED",
    "mountain scenario should produce a usable navigation result",
  );
  assert(mountain.autopilotOutput.fixUsable, "mountain scenario should expose a usable navigation output");
  assert(mountain.terrainReliefM > taiga.terrainReliefM, "mountain scenario should have more expressive relief than Vanavara");
  assert(mountain.best.correlation > 0.95, "mountain scenario should produce a strong profile match");

  const flatScenario = runTerrainMatching(FLAT_DEMO_CONFIG);
  assert(
    flatScenario.navigationStatus === "LOW RELIEF" ||
      flatScenario.navigationStatus === "FIX AMBIGUOUS" ||
      flatScenario.navigationStatus === "NO FIX",
    "plain/lake scenario should not report a confident coordinate",
  );
  assert(!flatScenario.autopilotOutput.fixUsable, "plain/lake scenario should not expose a usable navigation output");
  assert(flatScenario.best.confidence < taiga.best.confidence, "plain/lake scenario should lower confidence versus Vanavara");
  const firstAutopilotOutput = buildAutopilotOutputAtPoint(
    taiga.estimatedPath[0],
    taiga.best,
    taiga.navigationStatus,
    taiga.terrainStdM,
    taiga.ambiguity,
    taiga.config,
  );
  const finalAutopilotOutput = buildAutopilotOutputAtPoint(
    taiga.estimatedPath[taiga.estimatedPath.length - 1],
    taiga.best,
    taiga.navigationStatus,
    taiga.terrainStdM,
    taiga.ambiguity,
    taiga.config,
  );
  assert(
    Math.hypot(
      finalAutopilotOutput.localXM - firstAutopilotOutput.localXM,
      finalAutopilotOutput.localYM - firstAutopilotOutput.localYM,
    ) > 1000,
    "live autopilot output should move with the current aircraft point",
  );
  assert(
    Math.abs(finalAutopilotOutput.localXM - taiga.autopilotOutput.localXM) < 0.0001 &&
      Math.abs(finalAutopilotOutput.localYM - taiga.autopilotOutput.localYM) < 0.0001,
    "final live autopilot output should match the stored final package",
  );

  const finish = localPointToWgs84(taiga.estimatedPath[taiga.estimatedPath.length - 1]);
  assert(finish.lat > TAIGA_ROUTE.start.lat, "default route should move north-east from Vanavara");
  assert(finish.lon > TAIGA_ROUTE.start.lon, "default route should move east from Vanavara");

  const offPlan = runTerrainMatching({
    ...DEFAULT_MATCHER_CONFIG,
    trueAzimuthDeg: DEFAULT_MATCHER_CONFIG.plannedAzimuthDeg + 8,
  });
  assert(
    offPlan.autopilotOutput.courseCorrectionDeg !== null && Math.abs(offPlan.autopilotOutput.courseCorrectionDeg) >= 2,
    "course correction should be non-zero when estimated course diverges from plan",
  );

  const imported = solveFromNmea(taiga.nmea.join("\n"), {
    terrainKind: DEFAULT_MATCHER_CONFIG.terrainKind,
    baroAltitudeM: DEFAULT_MATCHER_CONFIG.baroAltitudeM,
    sampleRateHz: DEFAULT_MATCHER_CONFIG.sampleRateHz,
    speedMinMps: DEFAULT_MATCHER_CONFIG.speedMinMps,
    speedMaxMps: DEFAULT_MATCHER_CONFIG.speedMaxMps,
    speedStepMps: DEFAULT_MATCHER_CONFIG.speedStepMps,
    plannedAzimuthDeg: DEFAULT_MATCHER_CONFIG.plannedAzimuthDeg,
    courseLookaheadM: DEFAULT_MATCHER_CONFIG.courseLookaheadM,
  });
  assert(!imported.truthAvailable, "NMEA solver should not require truthPath");
  assert(imported.truthPath.length === 0, "imported NMEA result must not carry synthetic truthPath");
  assert(imported.estimatedPath.length === imported.samples.length, "imported/raw NMEA path should return an estimated path");
  assert(angleError(imported.best.azimuthDeg, DEFAULT_MATCHER_CONFIG.trueAzimuthDeg) <= 2, "solver should recover azimuth from raw NMEA");
  assert(Math.abs(imported.best.speedMps - DEFAULT_MATCHER_CONFIG.trueSpeedMps) <= 1, "solver should recover speed from raw NMEA");
  assert(imported.finalErrorM === null && imported.speedErrorMps === null, "truth metrics should be unavailable for imported logs");
  assert(imported.nmeaQuality.checksumOk === imported.samples.length, "imported generated NMEA should retain checksum quality");
  assert(imported.events[0]?.code === "RA_STREAM_STARTED", "solver should emit an event log from the current calculation");
  assert(imported.events.some((event) => event.code === "BEST_CANDIDATE"), "solver should log the selected best candidate");
  assert(imported.autopilotOutput.courseCorrectionDeg !== null, "imported NMEA should expose course correction when a route plan is configured");
  assert(Math.abs(imported.autopilotOutput.courseCorrectionDeg) <= 0.2, "imported stand NMEA should stay on the planned route");
  assert(imported.autopilotOutput.confidence > 0.7, "autopilot output should carry normalized confidence");
  assert(imported.autopilotOutput.fixUsable, "imported stand NMEA should be marked usable for navigation output");
  assert(Number.isFinite(imported.autopilotOutput.localXM), "autopilot output should expose local X coordinate");
  assert(Number.isFinite(imported.autopilotOutput.localYM), "autopilot output should expose local Y coordinate");
  assert(Math.hypot(imported.autopilotOutput.localXM, imported.autopilotOutput.localYM) > 1000, "local X/Y should be in DEM meters");

  const vanavaraControlNmea = readFileSync("examples/vanavara-success-radio-altimeter.nmea", "utf8");
  const vanavaraControl = solveFromNmea(vanavaraControlNmea, {
    terrainKind: DEFAULT_MATCHER_CONFIG.terrainKind,
    baroAltitudeM: DEFAULT_MATCHER_CONFIG.baroAltitudeM,
    sampleRateHz: DEFAULT_MATCHER_CONFIG.sampleRateHz,
    speedMinMps: DEFAULT_MATCHER_CONFIG.speedMinMps,
    speedMaxMps: DEFAULT_MATCHER_CONFIG.speedMaxMps,
    speedStepMps: DEFAULT_MATCHER_CONFIG.speedStepMps,
    plannedAzimuthDeg: DEFAULT_MATCHER_CONFIG.plannedAzimuthDeg,
    courseLookaheadM: DEFAULT_MATCHER_CONFIG.courseLookaheadM,
  });
  const vanavaraWgs84 = localPointToWgs84(vanavaraControl.estimatedPath[vanavaraControl.estimatedPath.length - 1]);
  assert(!vanavaraControl.truthAvailable, "Vanavara control NMEA must solve without truth");
  assert(vanavaraControl.truthPath.length === 0, "Vanavara control NMEA must not carry truthPath");
  assert(vanavaraControl.finalErrorM === null && vanavaraControl.speedErrorMps === null, "Vanavara control truth metrics must stay unavailable");
  assert(
    vanavaraControl.navigationStatus === "FIX VALID" || vanavaraControl.navigationStatus === "FIX DEGRADED",
    "Vanavara external control NMEA should produce a usable fix",
  );
  assert(vanavaraControl.samples.length === 4801, "Vanavara control fixture should keep every imported sentence");
  assert(vanavaraControl.nmeaQuality.checksumInvalid === 0, "Vanavara control fixture should pass checksum policy");
  assert(vanavaraControl.best.correlation > 0.95, "Vanavara control fixture should produce a strong correlation peak");
  assert(vanavaraControl.autopilotOutput.confidence > 0.7, "Vanavara control autopilot output should carry useful confidence");
  assert(vanavaraControl.autopilotOutput.fixUsable, "Vanavara control should expose a usable navigation output");
  assert(Math.abs(vanavaraControl.best.speedMps - DEFAULT_MATCHER_CONFIG.trueSpeedMps) <= 1, "Vanavara control should recover speed from file");
  assert(angleError(vanavaraControl.best.azimuthDeg, DEFAULT_MATCHER_CONFIG.trueAzimuthDeg) <= 2, "Vanavara control should recover azimuth from file");
  assert(Number.isFinite(vanavaraControl.autopilotOutput.localXM), "Vanavara control should expose local X");
  assert(Number.isFinite(vanavaraControl.autopilotOutput.localYM), "Vanavara control should expose local Y");
  assert(Number.isFinite(vanavaraWgs84.lat) && Number.isFinite(vanavaraWgs84.lon), "Vanavara control should expose WGS-84 coordinates");

  const px4ExternalNmea = readFileSync("examples/px4-derived-radio-altimeter.nmea", "utf8");
  const px4Imported = solveFromNmea(px4ExternalNmea, {
    terrainKind: DEFAULT_MATCHER_CONFIG.terrainKind,
    baroAltitudeM: DEFAULT_MATCHER_CONFIG.baroAltitudeM,
    sampleRateHz: DEFAULT_MATCHER_CONFIG.sampleRateHz,
    speedMinMps: DEFAULT_MATCHER_CONFIG.speedMinMps,
    speedMaxMps: DEFAULT_MATCHER_CONFIG.speedMaxMps,
    speedStepMps: DEFAULT_MATCHER_CONFIG.speedStepMps,
    plannedAzimuthDeg: DEFAULT_MATCHER_CONFIG.plannedAzimuthDeg,
    courseLookaheadM: DEFAULT_MATCHER_CONFIG.courseLookaheadM,
  });
  assert(!px4Imported.truthAvailable, "PX4-derived external NMEA file should solve without truth");
  assert(px4Imported.samples.length === 1690, "PX4-derived external NMEA fixture should keep every imported sentence");
  assert(px4Imported.nmeaQuality.checksumInvalid === 0, "PX4-derived external NMEA fixture should pass checksum policy");
  assert(px4Imported.events.some((event) => event.code === "RA_STREAM_STARTED"), "PX4-derived import should produce algorithm events");
  assert(px4Imported.navigationStatus === "NO FIX", "incompatible external journal should produce NO FIX");
  assert(px4Imported.autopilotOutput.courseCorrectionDeg === null, "PX4-derived NO FIX import should not expose course correction");
  assert(!px4Imported.autopilotOutput.fixUsable, "PX4-derived NO FIX import should not expose a usable navigation output");

  const invalidChecksumLog = taiga.nmea.slice(0, 24).map((row) => row.replace(/\*[0-9A-F]{2}$/i, "*00")).join("\n");
  const invalidChecksumResult = solveFromNmea(invalidChecksumLog, {
    terrainKind: DEFAULT_MATCHER_CONFIG.terrainKind,
    baroAltitudeM: DEFAULT_MATCHER_CONFIG.baroAltitudeM,
    sampleRateHz: DEFAULT_MATCHER_CONFIG.sampleRateHz,
    speedMinMps: DEFAULT_MATCHER_CONFIG.speedMinMps,
    speedMaxMps: DEFAULT_MATCHER_CONFIG.speedMaxMps,
    speedStepMps: DEFAULT_MATCHER_CONFIG.speedStepMps,
    plannedAzimuthDeg: DEFAULT_MATCHER_CONFIG.plannedAzimuthDeg,
    courseLookaheadM: DEFAULT_MATCHER_CONFIG.courseLookaheadM,
  });
  assert(invalidChecksumResult.nmeaQuality.checksumInvalid === 24, "solver should report invalid NMEA checksums");
  assert(invalidChecksumResult.navigationStatus !== "FIX VALID", "invalid checksum majority should prevent a clean VALID status");

  const flat = runTerrainMatching({
    ...DEFAULT_MATCHER_CONFIG,
    terrainKind: "flat",
    radioNoiseM: 10,
  });
  assert(flat.best.confidence < taiga.best.confidence, "flat noisy terrain should reduce self-estimated confidence");
  assert(flat.navigationStatus !== "FIX VALID", "flat or low-informative terrain should degrade navigation status");

  assert(
    classifyNavigationStatus(95, 240, 45, 0.03, 0.98, 12).navigationStatus === "FIX VALID",
    "status classifier should allow a high-quality fix",
  );
  assert(
    classifyNavigationStatus(58, 240, 45, 0.03, 0.82, 35).navigationStatus === "FIX DEGRADED",
    "status classifier should degrade medium confidence",
  );
  assert(
    classifyNavigationStatus(86, 240, 45, 0.002, 0.94, 25).navigationStatus === "FIX AMBIGUOUS",
    "status classifier should catch ambiguous peaks",
  );
  assert(
    classifyNavigationStatus(86, 20, 4, 0.03, 0.94, 25).navigationStatus === "LOW RELIEF",
    "status classifier should catch low-relief terrain",
  );
  assert(
    classifyNavigationStatus(10, 240, 45, 0.03, 0.2, 260).navigationStatus === "NO FIX",
    "status classifier should reject low-quality candidates",
  );

  const noFix = solveFromMeasuredProfile({
    config: {
      terrainKind: "taiga",
      baroAltitudeM: DEFAULT_MATCHER_CONFIG.baroAltitudeM,
      sampleRateHz: DEFAULT_MATCHER_CONFIG.sampleRateHz,
      speedMinMps: DEFAULT_MATCHER_CONFIG.speedMinMps,
      speedMaxMps: DEFAULT_MATCHER_CONFIG.speedMaxMps,
      speedStepMps: DEFAULT_MATCHER_CONFIG.speedStepMps,
      plannedAzimuthDeg: DEFAULT_MATCHER_CONFIG.plannedAzimuthDeg,
      courseLookaheadM: DEFAULT_MATCHER_CONFIG.courseLookaheadM,
    },
    measuredProfile: Array.from({ length: 96 }, (_, index) => (index % 2 === 0 ? 980 : -120)),
  });
  assert(noFix.navigationStatus === "NO FIX", "unmatched high-energy profile should produce NO FIX");
  assert(noFix.autopilotOutput.uncertaintyM === null, "NO FIX should not expose a fake uncertainty radius");
  assert(!noFix.autopilotOutput.fixUsable, "NO FIX should not expose a usable navigation output");

  console.log("Smoke tests passed: NMEA radio altimeter, taiga route, terrain correlation, map estimate");
}

run();
