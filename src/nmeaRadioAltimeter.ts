export type RadioAltimeterSample = {
  t: number;
  radioAltitudeM: number;
  baroAltitudeM: number;
  terrainMslM: number;
  sentence: string;
  checksumOk: boolean;
};

export function nmeaChecksum(payload: string): string {
  let checksum = 0;
  for (let i = 0; i < payload.length; i += 1) {
    checksum ^= payload.charCodeAt(i);
  }
  return checksum.toString(16).toUpperCase().padStart(2, "0");
}

function formatNmeaTime(seconds: number): string {
  const normalized = ((seconds % 86400) + 86400) % 86400;
  const hours = Math.floor(normalized / 3600);
  const minutes = Math.floor((normalized - hours * 3600) / 60);
  const wholeSeconds = Math.floor(normalized - hours * 3600 - minutes * 60);
  const milliseconds = Math.round((normalized - Math.floor(normalized)) * 1000);
  return `${String(hours).padStart(2, "0")}${String(minutes).padStart(2, "0")}${String(wholeSeconds).padStart(2, "0")}.${String(milliseconds).padStart(3, "0")}`;
}

function parseNmeaTime(value: string): number {
  if (!/^\d{6}(?:\.\d+)?$/.test(value)) return 0;
  const hours = Number(value.slice(0, 2));
  const minutes = Number(value.slice(2, 4));
  const seconds = Number(value.slice(4));
  return hours * 3600 + minutes * 60 + seconds;
}

export function buildGgaRadioSentence(t: number, radioAltitudeM: number, geoidSeparationM = 46.9): string {
  const time = formatNmeaTime(t);
  const payload = `GPGGA,${time},,,,,,,,${radioAltitudeM.toFixed(1)},M,${geoidSeparationM.toFixed(1)},M,,`;
  return `$${payload}*${nmeaChecksum(payload)}`;
}

export function parseGgaRadioSentence(sentence: string, baroAltitudeM: number): RadioAltimeterSample {
  const trimmed = sentence.trim();
  const body = trimmed.startsWith("$") ? trimmed.slice(1) : trimmed;
  const [payload, providedChecksum] = body.split("*");
  const fields = payload.split(",");

  if (fields[0] !== "GPGGA" && fields[0] !== "GNGGA") {
    throw new Error(`Unsupported NMEA sentence: ${fields[0] || "empty"}`);
  }

  const radioAltitudeM = Number(fields[9]);
  if (!Number.isFinite(radioAltitudeM)) {
    throw new Error(`NMEA GGA radio altitude is missing: ${sentence}`);
  }

  const checksumOk = providedChecksum
    ? nmeaChecksum(payload) === providedChecksum.toUpperCase()
    : false;

  return {
    t: parseNmeaTime(fields[1] ?? "0"),
    radioAltitudeM,
    baroAltitudeM,
    terrainMslM: baroAltitudeM - radioAltitudeM,
    sentence: trimmed,
    checksumOk,
  };
}

export function parseNmeaStream(text: string, baroAltitudeM: number): RadioAltimeterSample[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => parseGgaRadioSentence(line, baroAltitudeM));
}
