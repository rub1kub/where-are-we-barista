import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rustRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const repoRoot = path.resolve(rustRoot, "..");
const sourcePath = path.join(repoRoot, "src", "copernicusDemSample.ts");
const outputPath = path.join(rustRoot, "data", "dem-sample.json");

function matchNumber(source, pattern, name) {
  const match = source.match(pattern);
  if (!match) throw new Error(`Cannot read ${name}`);
  return Number(match[1]);
}

function matchString(source, pattern, name) {
  const match = source.match(pattern);
  if (!match) throw new Error(`Cannot read ${name}`);
  return match[1];
}

const source = await readFile(sourcePath, "utf8");
const elevationBlock = source.match(/elevationM:\s*\[([\s\S]*?)\n\s*\],\n};/);
if (!elevationBlock) throw new Error("Cannot read elevationM array");

const heights = elevationBlock[1].match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
const width = matchNumber(source, /width:\s*(\d+)/, "width");
const height = matchNumber(source, /height:\s*(\d+)/, "height");

const dem = {
  source_name: matchString(source, /sourceName:\s*"([^"]+)"/, "sourceName"),
  generated_at: matchString(source, /generatedAt:\s*"([^"]+)"/, "generatedAt"),
  region: matchString(source, /region:\s*"([^"]+)"/, "region"),
  width,
  height,
  min_lat: matchNumber(source, /latMin:\s*([0-9.]+)/, "latMin"),
  max_lat: matchNumber(source, /latMax:\s*([0-9.]+)/, "latMax"),
  min_lon: matchNumber(source, /lonMin:\s*([0-9.]+)/, "lonMin"),
  max_lon: matchNumber(source, /lonMax:\s*([0-9.]+)/, "lonMax"),
  origin_lat: 60.3446,
  origin_lon: 102.2797,
  heights_m: heights,
};

if (heights.length !== width * height) {
  throw new Error(`DEM size mismatch: ${heights.length} values for ${width}x${height}`);
}

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(dem)}\n`, "utf8");
console.log(`Exported ${outputPath} (${width}x${height}, ${heights.length} heights)`);

