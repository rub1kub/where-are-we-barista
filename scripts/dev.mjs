import { createServer } from "node:http";
import { existsSync, watch } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "./build.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const distDir = path.join(root, "dist");
const srcDir = path.join(root, "src");
const port = Number(process.env.PORT ?? 5173);
let rebuildTimer;
let building = Promise.resolve();

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

async function rebuild() {
  building = building
    .catch(() => undefined)
    .then(() => buildApp({ minify: false }))
    .then(() => console.log("Rebuilt app"))
    .catch((error) => console.error(error));
  return building;
}

function safePath(requestUrl) {
  const url = new URL(requestUrl ?? "/", "http://127.0.0.1");
  const pathname = decodeURIComponent(url.pathname);
  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  const filePath = path.resolve(distDir, requested);
  if (!filePath.startsWith(distDir)) return undefined;
  return filePath;
}

await rebuild();

if (existsSync(srcDir)) {
  watch(srcDir, { recursive: true }, () => {
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(rebuild, 120);
  });
}

const server = createServer(async (req, res) => {
  await building;
  const filePath = safePath(req.url);
  if (!filePath) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const info = await stat(filePath);
    const finalPath = info.isDirectory() ? path.join(filePath, "index.html") : filePath;
    const body = await readFile(finalPath);
    const type = contentTypes[path.extname(finalPath)] ?? "application/octet-stream";
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Dev server: http://127.0.0.1:${port}`);
});
