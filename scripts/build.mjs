import * as esbuild from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const distDir = path.join(root, "dist");
const examplesDir = path.join(root, "examples");

export async function buildApp({ minify = true } = {}) {
  await rm(distDir, { recursive: true, force: true });
  await mkdir(path.join(distDir, "assets"), { recursive: true });

  await esbuild.build({
    entryPoints: [path.join(root, "src/main.tsx")],
    bundle: true,
    outfile: path.join(distDir, "assets/app.js"),
    format: "esm",
    platform: "browser",
    jsx: "automatic",
    sourcemap: !minify,
    minify,
    logLevel: "silent",
  });

  const html = await readFile(path.join(root, "index.html"), "utf8");
  const builtHtml = html.replace(
    '<script type="module" src="/src/main.tsx"></script>',
    '<link rel="stylesheet" href="./assets/app.css" />\n    <script type="module" src="./assets/app.js"></script>',
  );
  await writeFile(path.join(distDir, "index.html"), builtHtml);
  await cp(examplesDir, path.join(distDir, "examples"), { recursive: true });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await buildApp({ minify: process.env.NODE_ENV !== "development" });
  console.log(`Built ${distDir}`);
}
