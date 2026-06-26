import { writeFile } from "node:fs/promises";
import { fromUrl } from "geotiff";

const TILE_LONS = [102, 103, 104, 105];
const LAT_BAND = 60;
const SAMPLE = {
  latMin: 60.25,
  latMax: 60.95,
  lonMin: 102.15,
  lonMax: 105.65,
  width: 420,
  height: 180,
};

function tileUrl(lon) {
  return `https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_N${LAT_BAND}_00_E${lon}_00_DEM/Copernicus_DSM_COG_10_N${LAT_BAND}_00_E${lon}_00_DEM.tif`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

async function loadTile(lon) {
  const url = tileUrl(lon);
  const tiff = await fromUrl(url);
  const image = await tiff.getImage();
  const raster = (await image.readRasters())[0];
  return {
    lon,
    url,
    bbox: image.getBoundingBox(),
    width: image.getWidth(),
    height: image.getHeight(),
    raster,
  };
}

function sampleTile(tile, lat, lon) {
  const [lonMin, latMin, lonMax, latMax] = tile.bbox;
  const px = ((lon - lonMin) / (lonMax - lonMin)) * (tile.width - 1);
  const py = ((latMax - lat) / (latMax - latMin)) * (tile.height - 1);
  const x0 = clamp(Math.floor(px), 0, tile.width - 1);
  const y0 = clamp(Math.floor(py), 0, tile.height - 1);
  const x1 = clamp(x0 + 1, 0, tile.width - 1);
  const y1 = clamp(y0 + 1, 0, tile.height - 1);
  const tx = px - x0;
  const ty = py - y0;
  const i00 = y0 * tile.width + x0;
  const i10 = y0 * tile.width + x1;
  const i01 = y1 * tile.width + x0;
  const i11 = y1 * tile.width + x1;
  const top = tile.raster[i00] * (1 - tx) + tile.raster[i10] * tx;
  const bottom = tile.raster[i01] * (1 - tx) + tile.raster[i11] * tx;
  return top * (1 - ty) + bottom * ty;
}

function sampleDem(tiles, lat, lon) {
  const tile = tiles.get(Math.floor(lon));
  if (!tile) throw new Error(`No Copernicus tile for lon=${lon}`);
  return sampleTile(tile, lat, lon);
}

function formatArray(values) {
  const rows = [];
  for (let y = 0; y < SAMPLE.height; y += 1) {
    const start = y * SAMPLE.width;
    const row = values
      .slice(start, start + SAMPLE.width)
      .map((value) => value.toFixed(1))
      .join(", ");
    rows.push(`    ${row}`);
  }
  return rows.join(",\n");
}

const tiles = new Map();
for (const lon of TILE_LONS) {
  console.log(`Loading Copernicus DEM tile E${lon}...`);
  tiles.set(lon, await loadTile(lon));
}

const elevationM = [];
for (let y = 0; y < SAMPLE.height; y += 1) {
  const lat = SAMPLE.latMax - (y / (SAMPLE.height - 1)) * (SAMPLE.latMax - SAMPLE.latMin);
  for (let x = 0; x < SAMPLE.width; x += 1) {
    const lon = SAMPLE.lonMin + (x / (SAMPLE.width - 1)) * (SAMPLE.lonMax - SAMPLE.lonMin);
    elevationM.push(sampleDem(tiles, lat, lon));
  }
}

const min = Math.min(...elevationM);
const max = Math.max(...elevationM);
const generatedAt = new Date().toISOString();
const sourceUrls = TILE_LONS.map(tileUrl);

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
  sourceName: "Copernicus DEM GLO-30 COG",
  sourceUrls: ${JSON.stringify(sourceUrls, null, 2).replace(/\n/g, "\n  ")},
  generatedAt: "${generatedAt}",
  region: "Красноярский край, район Ванавары и Подкаменной Тунгуски",
  bounds: {
    latMin: ${SAMPLE.latMin},
    latMax: ${SAMPLE.latMax},
    lonMin: ${SAMPLE.lonMin},
    lonMax: ${SAMPLE.lonMax},
  },
  width: ${SAMPLE.width},
  height: ${SAMPLE.height},
  minElevationM: ${min.toFixed(1)},
  maxElevationM: ${max.toFixed(1)},
  elevationM: [
${formatArray(elevationM)}
  ],
};
`;

await writeFile(new URL("../src/copernicusDemSample.ts", import.meta.url), content);
console.log(`Generated src/copernicusDemSample.ts (${SAMPLE.width}x${SAMPLE.height}, ${min.toFixed(1)}-${max.toFixed(1)} m)`);
