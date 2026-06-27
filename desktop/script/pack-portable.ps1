#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Builds and packages a portable standalone copy of Aria Chat
  (Electron app + compiled server binary). No repo source required to run.
.DESCRIPTION
  1. Builds the Electron app via electron-vite.
  2. Builds the MiMo Code server into a standalone binary via bun build --compile
     (current platform only, using --single flag).
  3. Copies Electron runtime + app output + server binary into dist-portable/.
  4. Zips the result into aria-chat-portable-win32-x64.zip.
#>

param(
  [switch]$SkipBuild,
  [switch]$SkipZip
)

$ErrorActionPreference = "Stop"
$root = Resolve-Path "$PSScriptRoot\.."
$distDir = Join-Path $root "dist-portable"

Write-Host "=== Building Aria Chat portable ===" -ForegroundColor Cyan

# ── 1. Build Electron app ──────────────────────────────────────────────
if (-not $SkipBuild) {
  Write-Host "[1/4] Building Electron app..." -ForegroundColor Yellow
  Push-Location $root
  try {
    npx electron-vite build 2>&1 | ForEach-Object { Write-Host "  $_" }
    if ($LASTEXITCODE -ne 0) { throw "electron-vite build failed" }
  } finally { Pop-Location }
} else {
  Write-Host "[1/4] SkipBuild: using existing out/" -ForegroundColor DarkGray
}

# ── 2. Build server binary ─────────────────────────────────────────────
$serverDir = Resolve-Path "$root\..\packages\opencode"
$binName = if ($IsWindows -or $env:OS -eq "Windows_NT") { "mimo.exe" } else { "mimo" }

if (-not $SkipBuild) {
  Write-Host "[2/4] Building server binary (this may take a few minutes)..." -ForegroundColor Yellow
  Push-Location $serverDir
  try {
    $proc = Start-Process -FilePath "bun" -ArgumentList "run","script/build.ts","--single" -NoNewWindow -Wait -PassThru
    if ($proc.ExitCode -ne 0) { throw "server build failed (exit code $($proc.ExitCode))" }
  } finally { Pop-Location }

  $distGlob = Get-ChildItem -Path (Join-Path $serverDir "dist") -Directory | Where-Object { $_.Name -like "mimocode-*" }
  if (-not $distGlob) { throw "No server build output found in dist/" }
  $serverBuildDir = Join-Path $distGlob.FullName "bin"
  $serverBinary = Join-Path $serverBuildDir $binName
  if (-not (Test-Path $serverBinary)) { throw "Server binary not found: $serverBinary" }
  Write-Host "  Server binary: $serverBinary" -ForegroundColor Green
} else {
  Write-Host "[2/4] SkipBuild: using existing server binary" -ForegroundColor DarkGray
  $distGlob = Get-ChildItem -Path (Join-Path $serverDir "dist") -Directory | Where-Object { $_.Name -like "mimocode-*" }
  if (-not $distGlob) { throw "No server build output found in dist/" }
  $serverBuildDir = Join-Path $distGlob.FullName "bin"
  $serverBinary = Join-Path $serverBuildDir $binName
  if (-not (Test-Path $serverBinary)) { throw "Server binary not found: $serverBinary" }
}

# ── 3. Assemble portable directory ─────────────────────────────────────
Write-Host "[3/4] Assembling portable package..." -ForegroundColor Yellow

if (Test-Path $distDir) { Remove-Item -Recurse -Force $distDir }
New-Item -ItemType Directory -Path $distDir -Force | Out-Null

# 3a. Copy server binary
$serverOutDir = Join-Path $distDir "server"
New-Item -ItemType Directory -Path $serverOutDir -Force | Out-Null
Copy-Item $serverBinary $serverOutDir
Write-Host "  Copied server binary to server\$binName"

# 3b. Copy Electron runtime
$electronRoot = Resolve-Path "$root\node_modules\electron"
$electronDist = Join-Path $electronRoot "dist"
$electronExe = if ($IsWindows -or $env:OS -eq "Windows_NT") { "electron.exe" } else { "electron" }
if (-not (Test-Path (Join-Path $electronDist $electronExe))) {
  throw "Electron runtime not found at $electronDist\$electronExe"
}
Copy-Item (Join-Path $electronDist $electronExe) (Join-Path $distDir "aria-chat.exe")
# Copy the rest of the Electron runtime next to the exe (dlls, *.pak/*.bin/*.dat,
# and the locales\ directory). -Recurse is REQUIRED: locales\ holds the *.pak
# files Electron loads at startup, and without -Recurse it would be created empty,
# which makes the portable app fail to boot. We skip Electron's default "resources"
# (default_app.asar — replaced below by our own resources\app) and the original
# electron.exe (already shipped above under our own name).
Get-ChildItem $electronDist -Exclude "resources", $electronExe | ForEach-Object {
  Copy-Item $_.FullName -Destination $distDir -Recurse -Force
}
Write-Host "  Copied Electron runtime"

# 3c. Copy app files as resources/app
$resourcesDir = Join-Path $distDir "resources"
New-Item -ItemType Directory -Path $resourcesDir -Force | Out-Null
$appDir = Join-Path $resourcesDir "app"
New-Item -ItemType Directory -Path $appDir -Force | Out-Null

# Minimal app: package.json (entry point) + out/ (bundled code).
# The out/ bundles are self-contained — main.js has no external requires,
# preload only requires "electron" (provided by runtime), and the renderer
# is a standalone Vite bundle.
Copy-Item (Join-Path $root "package.json") $appDir
Copy-Item (Join-Path $root "out") (Join-Path $appDir "out") -Recurse
# Shared assets (app icon etc.) — the main process looks for these at out/shared/img/.
$sharedTargetDir = Join-Path $appDir "out\shared\img"
New-Item -ItemType Directory -Path $sharedTargetDir -Force | Out-Null
Copy-Item (Join-Path $root "src\shared\img\aria-icon.png") $sharedTargetDir -Force
Write-Host "  Copied app files (out/ + package.json + shared assets)"

Write-Host "Portable package assembled at $distDir" -ForegroundColor Green

# ── 4. Zip ──────────────────────────────────────────────────────────────
if (-not $SkipZip) {
  Write-Host "[4/4] Creating zip archive..." -ForegroundColor Yellow
  $zipName = "aria-chat-portable-win32-x64.zip"
  $zipPath = Join-Path $root $zipName
  if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
  Compress-Archive -Path "$distDir\*" -DestinationPath $zipPath -Force
  $zipSize = [math]::Round((Get-Item $zipPath).Length / 1MB, 1)
  Write-Host "  Created $zipPath ($zipSize MB)" -ForegroundColor Green
}

Write-Host ""
Write-Host "=== Done ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "To run the portable copy:" -ForegroundColor White
Write-Host "  cd $distDir" -ForegroundColor White
Write-Host "  .\aria-chat.exe" -ForegroundColor White
Write-Host ""
Write-Host "The Electron app auto-detects the server binary in .\server\ and starts it." -ForegroundColor DarkGray