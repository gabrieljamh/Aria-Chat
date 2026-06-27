import { protocol } from "electron"
import * as fs from "node:fs"
import * as path from "node:path"

/**
 * Serves the previewed file's directory over a custom `mimo-file://` origin so
 * the FileViewer can render multi-file web apps the agent generated: relative
 * asset paths (./app.js, ./styles.css, assets/…) resolve against the document
 * URL instead of failing, and the iframe runs in its own real origin.
 *
 * Access is confined to directories explicitly opened for preview (one per
 * opened file), so a previewed page can read its own assets but not wander the
 * rest of the filesystem.
 */
export const PREVIEW_SCHEME = "mimo-file"
const PREVIEW_HOST = "app"

const allowedRoots = new Set<string>()

/** Must run before app `ready` (registers the scheme as a standard secure origin). */
export function registerPreviewScheme() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PREVIEW_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
    },
  ])
}

/** Allow previews from the file's directory and return the URL to load it by. */
export function allowPreviewRoot(filePath: string): string {
  const abs = path.resolve(filePath)
  allowedRoots.add(path.dirname(abs))
  const posix = abs.replace(/\\/g, "/")
  const withSlash = posix.startsWith("/") ? posix : "/" + posix
  return `${PREVIEW_SCHEME}://${PREVIEW_HOST}${encodeURI(withSlash)}`
}

function fsPathFromUrl(rawUrl: string): string {
  const u = new URL(rawUrl)
  let p = decodeURIComponent(u.pathname).replace(/^\//, "")
  if (!/^[A-Za-z]:/.test(p)) p = "/" + p // posix absolute
  return path.normalize(p)
}

function isAllowed(fsPath: string): boolean {
  for (const root of allowedRoots) {
    if (fsPath === root || fsPath.startsWith(root + path.sep)) return true
  }
  return false
}

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".htm": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".cjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".bmp": "image/bmp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".map": "application/json",
  ".txt": "text/plain",
  ".webmanifest": "application/manifest+json",
}
function mimeFor(p: string): string {
  return MIME[path.extname(p).toLowerCase()] ?? "application/octet-stream"
}

/** Must run after app `ready`. */
export function registerPreviewProtocol() {
  protocol.handle(PREVIEW_SCHEME, async (request) => {
    try {
      const fsPath = fsPathFromUrl(request.url)
      if (!isAllowed(fsPath)) return new Response("Forbidden", { status: 403 })
      const stat = await fs.promises.stat(fsPath).catch(() => null)
      if (!stat || !stat.isFile()) return new Response("Not found", { status: 404 })
      const data = await fs.promises.readFile(fsPath)
      return new Response(new Uint8Array(data), {
        headers: { "content-type": mimeFor(fsPath), "cache-control": "no-cache" },
      })
    } catch {
      return new Response("Not found", { status: 404 })
    }
  })
}
