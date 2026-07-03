import path from "path"
import * as Process from "./process"

export async function extractZip(zipPath: string, destDir: string) {
  if (process.platform === "win32") {
    const winZipPath = path.resolve(zipPath)
    const winDestDir = path.resolve(destDir)
    const cmd = `$global:ProgressPreference = 'SilentlyContinue'; Expand-Archive -Path '${winZipPath}' -DestinationPath '${winDestDir}' -Force`
    await Process.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", cmd])
    return
  }

  await Process.run(["unzip", "-o", "-q", zipPath, "-d", destDir])
}

export async function extractTar(tarPath: string, destDir: string) {
  await Process.run(["tar", "-xf", tarPath, "-C", destDir])
}

export async function extractTarGz(tarGzPath: string, destDir: string) {
  await Process.run(["tar", "-xzf", tarGzPath, "-C", destDir])
}

export async function extract7z(archivePath: string, destDir: string) {
  await Process.run(["7z", "x", archivePath, `-o${destDir}`, "-y"])
}

export async function extractRar(rarPath: string, destDir: string) {
  await Process.run(["unrar", "x", "-o+", rarPath, destDir])
}

export async function extractGzip(gzPath: string, destDir: string) {
  const fs = await import("node:fs")
  const buf = fs.readFileSync(gzPath)
  const decompressed = Bun.gunzipSync(new Uint8Array(buf))
  const filename = path.basename(gzPath, ".gz")
  fs.writeFileSync(path.join(destDir, filename), decompressed)
}

export type ArchiveType = "zip" | "tar" | "tar.gz" | "7z" | "rar" | "gz"

export async function extractArchive(archivePath: string, type: ArchiveType, destDir: string) {
  switch (type) {
    case "zip": return extractZip(archivePath, destDir)
    case "tar": return extractTar(archivePath, destDir)
    case "tar.gz": return extractTarGz(archivePath, destDir)
    case "7z": return extract7z(archivePath, destDir)
    case "rar": return extractRar(archivePath, destDir)
    case "gz": return extractGzip(archivePath, destDir)
  }
}
