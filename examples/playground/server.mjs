#!/usr/bin/env node
// Zero-dependency static dev server for the playground.
// Flags mirror Vite so `npx ukacell --run` works unchanged:
//   node server.mjs [--host [address]] [--port <port>]
// Without --host it only listens on localhost (the phone cannot reach it).

import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("./public", import.meta.url)));
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function parseArgs(argv) {
  let host = "127.0.0.1";
  let port = 5173;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--host") {
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) {
        host = next;
        i += 1;
      } else {
        host = "0.0.0.0";
      }
    } else if (arg.startsWith("--host=")) {
      host = arg.slice("--host=".length) || "0.0.0.0";
    } else if (arg === "--port" && argv[i + 1]) {
      port = Number(argv[i + 1]);
      i += 1;
    } else if (arg.startsWith("--port=")) {
      port = Number(arg.slice("--port=".length));
    }
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`Invalid port: ${port}`);
    process.exit(1);
  }
  return { host, port };
}

function resolveFile(urlPath) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(urlPath, "http://x").pathname);
  } catch {
    return null;
  }
  const candidate = normalize(join(ROOT, pathname));
  if (candidate !== ROOT && !candidate.startsWith(ROOT + sep)) return null; // no ../ escapes
  try {
    const info = statSync(candidate);
    if (info.isDirectory()) return resolveFile(join(pathname, "index.html"));
    return candidate;
  } catch {
    return null;
  }
}

const { host, port } = parseArgs(process.argv.slice(2));

const server = createServer((request, response) => {
  const file = resolveFile(request.url || "/");
  const stamp = new Date().toLocaleTimeString();
  if (!file) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    console.log(`${stamp}  404 ${request.url}`);
    return;
  }
  response.writeHead(200, {
    "Content-Type": TYPES[extname(file)] || "application/octet-stream",
    "Cache-Control": "no-store",
  });
  createReadStream(file).pipe(response);
  console.log(`${stamp}  200 ${request.url}  (${request.socket.remoteAddress})`);
});

server.on("error", (error) => {
  console.error(error.code === "EADDRINUSE" ? `Port ${port} is already in use.` : error.message);
  process.exit(1);
});

server.listen(port, host, () => {
  const shown = host === "0.0.0.0" ? "all interfaces" : host;
  console.log(`playground: serving ./public on http://${host === "0.0.0.0" ? "localhost" : host}:${port} (${shown})`);
});
