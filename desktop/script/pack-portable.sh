#!/usr/bin/env bash
# Builds and packages a portable standalone copy of Aria Chat
# (Electron app + compiled server binary). No repo source required to run.
#
# Usage: ./pack-portable.sh [--skip-build] [--skip-zip]
# Env:   SERVER_OS (linux|darwin|win32), SERVER_ARCH (x64|arm64)

set -euo pipefail

SKIP_BUILD=false
SKIP_ZIP=false

for arg in "$@"; do
  case $arg in
    --skip-build) SKIP_BUILD=true ;;
    --skip-zip) SKIP_ZIP=true ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="$ROOT_DIR/dist-portable"

SERVER_OS="${SERVER_OS:-$(uname -s | tr '[:upper:]' '[:lower:]')}"
SERVER_ARCH="${SERVER_ARCH:-$(uname -m)}"

# Normalize arch
case "$SERVER_ARCH" in
  x86_64|amd64) SERVER_ARCH="x64" ;;
  aarch64|arm64) SERVER_ARCH="arm64" ;;
esac

# Normalize OS
case "$SERVER_OS" in
  linux) SERVER_OS="linux" ;;
  darwin|macos) SERVER_OS="darwin" ;;
  windows|win32|mingw*) SERVER_OS="win32" ;;
esac

# Build script uses "windows" not "win32" for directory naming
BUILD_TARGET_OS="$SERVER_OS"
if [[ "$SERVER_OS" == "win32" ]]; then
  BUILD_TARGET_OS="windows"
fi

BIN_NAME="mimo"
if [[ "$SERVER_OS" == "win32" ]]; then
  BIN_NAME="mimo.exe"
fi

echo "=== Building Aria Chat portable ==="
echo "Target: $SERVER_OS-$SERVER_ARCH (build dir: $BUILD_TARGET_OS-$SERVER_ARCH)"

# ── 1. Build Electron app ──────────────────────────────────────────────
if [[ "$SKIP_BUILD" != "true" ]]; then
  echo "[1/4] Building Electron app..."
  cd "$ROOT_DIR"
  npx electron-vite build 2>&1 | sed 's/^/  /'
  if [[ ${PIPESTATUS[0]} -ne 0 ]]; then
    echo "electron-vite build failed" >&2
    exit 1
  fi
else
  echo "[1/4] SkipBuild: using existing out/"
fi

# ── 2. Build server binary ─────────────────────────────────────────────
SERVER_DIR="$(cd "$ROOT_DIR/../packages/opencode" && pwd)"

if [[ "$SKIP_BUILD" != "true" ]]; then
  echo "[2/4] Building server binary (this may take a few minutes)..."
  cd "$SERVER_DIR"
  bun run script/build.ts --single 2>&1 | sed 's/^/  /'
  if [[ ${PIPESTATUS[0]} -ne 0 ]]; then
    echo "server build failed" >&2
    exit 1
  fi
else
  echo "[2/4] SkipBuild: using existing server binary"
fi

# Find the built server binary matching target platform
# Server build output dirs are named like: mimocode-linux-x64, mimocode-windows-x64, etc.
TARGET_DIR_PATTERN="mimocode-${BUILD_TARGET_OS}-${SERVER_ARCH}"
DIST_GLOB=$(find "$SERVER_DIR/dist" -maxdepth 1 -type d -name "${TARGET_DIR_PATTERN}*" | head -1)
if [[ -z "$DIST_GLOB" ]]; then
  echo "No server build output found for ${SERVER_OS}-${SERVER_ARCH} in dist/" >&2
  echo "Available:" >&2
  find "$SERVER_DIR/dist" -maxdepth 1 -type d -name "mimocode-*" | sed 's/^/  /' >&2
  exit 1
fi
SERVER_BUILD_DIR="$DIST_GLOB/bin"
SERVER_BINARY="$SERVER_BUILD_DIR/$BIN_NAME"
if [[ ! -f "$SERVER_BINARY" ]]; then
  echo "Server binary not found: $SERVER_BINARY" >&2
  exit 1
fi
echo "  Server binary: $SERVER_BINARY"

# ── 3. Assemble portable directory ─────────────────────────────────────
echo "[3/4] Assembling portable package..."

rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"

# 3a. Copy server binary
SERVER_OUT_DIR="$DIST_DIR/server"
mkdir -p "$SERVER_OUT_DIR"
cp "$SERVER_BINARY" "$SERVER_OUT_DIR/"
echo "  Copied server binary to server/$BIN_NAME"

# 3b. Copy Electron runtime
ELECTRON_ROOT="$(cd "$ROOT_DIR/node_modules/electron" && pwd)"
ELECTRON_DIST="$ELECTRON_ROOT/dist"
ELECTRON_EXE="electron"
if [[ "$(uname -s)" == "MINGW"* ]] || [[ "$(uname -s)" == "CYGWIN"* ]] || [[ "$(uname -s)" == "MSYS"* ]]; then
  ELECTRON_EXE="electron.exe"
fi

# macOS: Electron is distributed as an .app bundle
if [[ "$(uname -s)" == "Darwin" ]]; then
  ELECTRON_APP="$ELECTRON_DIST/Electron.app/Contents/MacOS/Electron"
  if [[ ! -f "$ELECTRON_APP" ]]; then
    echo "Electron runtime not found at $ELECTRON_APP" >&2
    exit 1
  fi
else
  if [[ ! -f "$ELECTRON_DIST/$ELECTRON_EXE" ]]; then
    echo "Electron runtime not found at $ELECTRON_DIST/$ELECTRON_EXE" >&2
    exit 1
  fi
fi

# Determine output executable name
if [[ "$(uname -s)" == "MINGW"* ]] || [[ "$(uname -s)" == "CYGWIN"* ]] || [[ "$(uname -s)" == "MSYS"* ]]; then
  APP_EXE="aria-chat.exe"
else
  APP_EXE="aria-chat"
fi

cp "$ELECTRON_EXE" "$DIST_DIR/$APP_EXE"

# Copy the rest of the Electron runtime (dlls, .pak, .bin, .dat, locales/)
# Exclude 'resources' (default_app.asar) and the original electron exe
if [[ "$(uname -s)" == "Darwin" ]]; then
  # macOS: copy from Electron.app/Contents/Resources/
  ELECTRON_RESOURCES="$ELECTRON_DIST/Electron.app/Contents/Resources"
  find "$ELECTRON_RESOURCES" -mindepth 1 -maxdepth 1 \
    ! -name "default_app.asar" \
    -exec cp -r {} "$DIST_DIR/" \;
else
  find "$ELECTRON_DIST" -mindepth 1 -maxdepth 1 \
    ! -name "resources" \
    ! -name "$(basename "$ELECTRON_EXE")" \
    -exec cp -r {} "$DIST_DIR/" \;
fi
echo "  Copied Electron runtime"

# 3c. Copy app files as resources/app
RESOURCES_DIR="$DIST_DIR/resources"
mkdir -p "$RESOURCES_DIR"
APP_DIR="$RESOURCES_DIR/app"
mkdir -p "$APP_DIR"

# Minimal app: package.json (entry point) + out/ (bundled code)
cp "$ROOT_DIR/package.json" "$APP_DIR/"
cp -r "$ROOT_DIR/out" "$APP_DIR/out"

# Shared assets (app icon etc.) — main process looks for these at out/shared/img/
SHARED_TARGET_DIR="$APP_DIR/out/shared/img"
mkdir -p "$SHARED_TARGET_DIR"
cp "$ROOT_DIR/src/shared/img/aria-icon.png" "$SHARED_TARGET_DIR/"
echo "  Copied app files (out/ + package.json + shared assets)"

# Make the app executable on Unix
if [[ "$(uname -s)" != "MINGW"* ]] && [[ "$(uname -s)" != "CYGWIN"* ]] && [[ "$(uname -s)" != "MSYS"* ]]; then
  chmod +x "$DIST_DIR/$APP_EXE"
fi

echo "Portable package assembled at $DIST_DIR"

# ── 4. Create archive ──────────────────────────────────────────────────
if [[ "$SKIP_ZIP" != "true" ]]; then
  echo "[4/4] Creating archive..."
  cd "$ROOT_DIR"

  # Determine archive name based on target platform
  if [[ "$SERVER_OS" == "linux" ]]; then
    ARCHIVE_NAME="aria-chat-portable-linux-${SERVER_ARCH}.tar.gz"
    tar -czf "$ARCHIVE_NAME" -C "$DIST_DIR" .
  elif [[ "$SERVER_OS" == "darwin" ]]; then
    ARCHIVE_NAME="aria-chat-portable-darwin-${SERVER_ARCH}.zip"
    # Use zip for macOS (more compatible with Gatekeeper)
    (cd "$DIST_DIR" && zip -r "../$ARCHIVE_NAME" .)
  else
    ARCHIVE_NAME="aria-chat-portable-win32-${SERVER_ARCH}.zip"
    (cd "$DIST_DIR" && zip -r "../$ARCHIVE_NAME" .)
  fi

  ARCHIVE_SIZE=$(du -h "$ROOT_DIR/$ARCHIVE_NAME" | cut -f1)
  echo "  Created $ARCHIVE_NAME ($ARCHIVE_SIZE)"
fi

echo ""
echo "=== Done ==="
echo ""
echo "To run the portable copy:"
echo "  cd $DIST_DIR"
echo "  ./$APP_EXE"
echo ""
echo "The Electron app auto-detects the server binary in ./server/ and starts it."