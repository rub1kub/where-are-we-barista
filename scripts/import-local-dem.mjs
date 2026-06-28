import { basename, resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { fromFile } from "geotiff";

const sourcePath = process.argv[2];
const sampleWidth = Number.parseInt(process.argv[3] ?? process.env.DEM_SAMPLE_WIDTH ?? "420", 10);
const sampleHeight = Number.parseInt(process.argv[4] ?? process.env.DEM_SAMPLE_HEIGHT ?? String(sampleWidth), 10);

if (!sourcePath) {
  console.error("Usage: npm run dem:import-local -- <path-to-map.tif> [sampleWidth] [sampleHeight]");
  process.exit(1);
}

if (!Number.isFinite(sampleWidth) || !Number.isFinite(sampleHeight) || sampleWidth < 16 || sampleHeight < 16) {
  throw new Error("Sample width/height must be finite numbers >= 16.");
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function formatArray(values, width) {
  const rows = [];
  for (let y = 0; y < values.length / width; y += 1) {
    const start = y * width;
    const row = values
      .slice(start, start + width)
      .map((value) => round1(value).toFixed(1))
      .join(", ");
    rows.push(`    ${row}`);
  }
  return rows.join(",\n");
}

const absolutePath = resolve(sourcePath);
const tiff = await fromFile(absolutePath);
const image = await tiff.getImage();
const [lonMin, latMin, lonMax, latMax] = image.getBoundingBox();
const raster = (await image.readRasters({
  width: sampleWidth,
  height: sampleHeight,
  resampleMethod: "bilinear",
}))[0];
const elevationM = Array.from(raster, (value) => round1(value));
const finiteElevationM = elevationM.filter(Number.isFinite);

if (finiteElevationM.length !== elevationM.length) {
  throw new Error("GeoTIFF contains no-data or non-finite cells after sampling.");
}

let min = Number.POSITIVE_INFINITY;
let max = Number.NEGATIVE_INFINITY;
for (const value of finiteElevationM) {
  min = Math.min(min, value);
  max = Math.max(max, value);
}
const generatedAt = new Date().toISOString();
const fileName = basename(absolutePath);
const region = `Полученная карта ${latMin.toFixed(2)}-${latMax.toFixed(2)} N, ${lonMin.toFixed(2)}-${lonMax.toFixed(2)} E`;

const content = `export type DemGrid = {
  sourceName: string;
  sourceUrls: string[];
  generatedAt: string;
  region: string;
  bounds: {
    latMin: number;
    latMax: number;
    lonMin: number;
    lonMax: number;
  };
  width: number;
  height: number;
  minElevationM: number;
  maxElevationM: number;
  elevationM: number[];
};

export const COPERNICUS_TAIGA_DEM: DemGrid = {
  sourceName: "Локальный GeoTIFF ${fileName}",
  sourceUrls: [
    "local:${fileName}"
  ],
  generatedAt: "${generatedAt}",
  region: "${region}",
  bounds: {
    latMin: ${latMin},
    latMax: ${latMax},
    lonMin: ${lonMin},
    lonMax: ${lonMax},
  },
  width: ${sampleWidth},
  height: ${sampleHeight},
  minElevationM: ${min.toFixed(1)},
  maxElevationM: ${max.toFixed(1)},
  elevationM: [
${formatArray(elevationM, sampleWidth)}
  ],
};
`;

await writeFile(new URL("../src/copernicusDemSample.ts", import.meta.url), content);
console.log(`Generated src/copernicusDemSample.ts from ${fileName} (${sampleWidth}x${sampleHeight}, ${min.toFixed(1)}-${max.toFixed(1)} m)`);
console.log(`Bounds: ${latMin.toFixed(6)}-${latMax.toFixed(6)} N, ${lonMin.toFixed(6)}-${lonMax.toFixed(6)} E`);
