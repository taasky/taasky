// What Workers' asset binding does before the Worker runs: a file in public/
// answers GET and HEAD at its own path. Everything else goes to the core.

import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

export async function serveStatic(dir: string, request: Request): Promise<Response | null> {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const path = decodeURIComponent(new URL(request.url).pathname);
  if (path === "/" || path.endsWith("/") || path.split("/").some((p) => p.startsWith("_") || p === "..")) return null;
  const file = normalize(join(dir, path));
  if (!file.startsWith(dir)) return null;
  try {
    if (!(await stat(file)).isFile()) return null;
  } catch {
    return null;
  }
  const body = request.method === "HEAD" ? null : await readFile(file);
  return new Response(body, {
    headers: { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "public, max-age=3600" },
  });
}
