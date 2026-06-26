import * as esbuild from "esbuild";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const tempDir = path.join(root, ".tmp");
const outfile = path.join(tempDir, "smoke-test.mjs");

await rm(tempDir, { recursive: true, force: true });
await mkdir(tempDir, { recursive: true });

await esbuild.build({
  entryPoints: [path.join(root, "src/smoke.test.ts")],
  bundle: true,
  outfile,
  platform: "node",
  format: "esm",
  logLevel: "silent",
});

const result = spawnSync(process.execPath, [outfile], { stdio: "inherit" });
await rm(tempDir, { recursive: true, force: true });
process.exit(result.status ?? 1);
