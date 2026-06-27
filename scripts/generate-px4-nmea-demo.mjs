import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const sourceCsv = path.join(root, "data", "import", "px4-fixed-wing-real-flight.csv");
const outputNmea = path.join(root, "examples", "px4-derived-radio-altimeter.nmea");
const baroMslM = 1500;
const geoidSeparationM = 46.9;

function checksum(payload) {
  let value = 0;
  for (let i = 0; i < payload.length; i += 1) value ^= payload.charCodeAt(i);
  return value.toString(16).toUpperCase().padStart(2, "0");
}

function formatNmeaTime(seconds) {
  const normalized = ((seconds % 86400) + 86400) % 86400;
  const hours = Math.floor(normalized / 3600);
  const minutes = Math.floor((normalized - hours * 3600) / 60);
  const wholeSeconds = Math.floor(normalized - hours * 3600 - minutes * 60);
  const milliseconds = Math.round((normalized - Math.floor(normalized)) * 1000);
  return `${String(hours).padStart(2, "0")}${String(minutes).padStart(2, "0")}${String(wholeSeconds).padStart(2, "0")}.${String(milliseconds).padStart(3, "0")}`;
}

function parseSimpleCsv(text) {
  const lines = text.replace(/^\uFEFF/, "").trim().split(/\r?\n/);
  const headers = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const values = line.split(",");
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
  });
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

if (!(await fileExists(sourceCsv))) {
  if (await fileExists(outputNmea)) {
    const existing = await readFile(outputNmea, "utf8");
    const sentenceCount = existing.split(/\r?\n/).filter(Boolean).length;
    console.warn(`Source CSV is not available: ${sourceCsv}`);
    console.warn(`Keeping committed NMEA fixture: ${outputNmea} (${sentenceCount} NMEA sentences)`);
    process.exit(0);
  }

  throw new Error(`Source CSV is not available: ${sourceCsv}`);
}

const csv = await readFile(sourceCsv, "utf8");
const rows = parseSimpleCsv(csv)
  .map((row) => ({
    t: Number(row["t_с"]),
    terrainMslM: Number(row["высота_MSL_м"]),
  }))
  .filter((row) => Number.isFinite(row.t) && Number.isFinite(row.terrainMslM))
  .sort((a, b) => a.t - b.t);

const nmea = rows.map((row) => {
  const radioAltitudeM = Math.max(1, baroMslM - row.terrainMslM);
  const payload = `GPGGA,${formatNmeaTime(row.t)},,,,,,,,${radioAltitudeM.toFixed(1)},M,${geoidSeparationM.toFixed(1)},M,,`;
  return `$${payload}*${checksum(payload)}`;
});

await mkdir(path.dirname(outputNmea), { recursive: true });
await writeFile(outputNmea, `${nmea.join("\n")}\n`, "utf8");
console.log(`Generated ${outputNmea} (${nmea.length} NMEA sentences)`);
