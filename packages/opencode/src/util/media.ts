import path from "path"
import type { ArchiveType } from "./archive"

const startsWith = (bytes: Uint8Array, prefix: number[]) => prefix.every((value, index) => bytes[index] === value)

export function isPdfAttachment(mime: string) {
  return mime === "application/pdf"
}

export function isMedia(mime: string) {
  return mime.startsWith("image/") || isPdfAttachment(mime)
}

export function isImageAttachment(mime: string) {
  return mime.startsWith("image/") && mime !== "image/svg+xml" && mime !== "image/vnd.fastbidsheet"
}

const ARCHIVE_MIMES = new Set([
  "application/zip", "application/x-zip-compressed",
  "application/x-tar", "application/tar",
  "application/gzip", "application/x-gzip",
  "application/x-7z-compressed",
  "application/x-rar-compressed", "application/vnd.rar",
])

export function isArchive(mime: string) {
  return ARCHIVE_MIMES.has(mime)
}

const ARCHIVE_TYPE_BY_MIME: Record<string, ArchiveType> = {
  "application/zip": "zip",
  "application/x-zip-compressed": "zip",
  "application/x-tar": "tar",
  "application/tar": "tar",
  "application/gzip": "gz",
  "application/x-gzip": "gz",
  "application/x-7z-compressed": "7z",
  "application/x-rar-compressed": "rar",
  "application/vnd.rar": "rar",
}

export function archiveTypeFromMime(mime: string): ArchiveType | null {
  return ARCHIVE_TYPE_BY_MIME[mime] ?? null
}

export function archiveTypeFromExt(filename: string): ArchiveType | null {
  const ext = path.extname(filename).toLowerCase()
  const lower = filename.toLowerCase()
  if (ext === ".zip") return "zip"
  if (ext === ".tar") return "tar"
  if (ext === ".tar.gz" || lower.endsWith(".tgz")) return "tar.gz"
  if (ext === ".gz") return lower.endsWith(".tar.gz") ? "tar.gz" : "gz"
  if (ext === ".7z") return "7z"
  if (ext === ".rar") return "rar"
  return null
}

export function sniffAttachmentMime(bytes: Uint8Array, fallback: string) {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png"
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg"
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif"
  if (startsWith(bytes, [0x42, 0x4d])) return "image/bmp"
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf"
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50])) {
    return "image/webp"
  }
  // Archive magic bytes
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return "application/zip"
  if (startsWith(bytes, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07])) return "application/x-rar-compressed"
  if (startsWith(bytes, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return "application/x-7z-compressed"
  if (startsWith(bytes, [0x1f, 0x8b])) return "application/gzip"

  return fallback
}

const TEXT_EXTS = new Set([
  ".txt", ".md", ".markdown", ".log", ".yml", ".yaml", ".toml", ".ini",
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs",
  ".java", ".c", ".h", ".cpp", ".cc", ".cs", ".rb", ".php", ".sh",
  ".css", ".scss", ".sql", ".json", ".csv", ".html", ".htm", ".xml",
  ".env", ".gitignore", ".dockerfile", ".makefile",
])

const EXT_MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".avif": "image/avif", ".bmp": "image/bmp", ".svg": "image/svg+xml",
  ".ico": "image/x-icon", ".pdf": "application/pdf",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4",
  ".ogg": "audio/ogg", ".flac": "audio/flac", ".aac": "audio/aac",
}

export function extMime(filename: string): string {
  const ext = path.extname(filename).toLowerCase()
  return EXT_MIME[ext] ?? "application/octet-stream"
}

export function isTextExt(filename: string): boolean {
  const ext = path.extname(filename).toLowerCase()
  if (TEXT_EXTS.has(ext)) return true
  const base = path.basename(filename).toLowerCase()
  return base === "dockerfile" || base === "makefile" || base === ".gitignore"
}
