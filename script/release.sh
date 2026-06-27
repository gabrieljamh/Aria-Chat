#!/usr/bin/env bash
set -e

if [ -z "$1" ]; then
  echo "Usage: ./script/release.sh <version>"
  echo "  e.g. ./script/release.sh 0.1.0"
  exit 1
fi

VERSION="$1"
TAG="v${VERSION}"

# Update desktop package.json version
pushd "$(dirname "$0")/.." > /dev/null
DESKTOP_PKG="desktop/package.json"
CURRENT_VERSION=$(node -p "require('./$DESKTOP_PKG').version")

if [ "$CURRENT_VERSION" = "$VERSION" ]; then
  echo "Version is already $VERSION"
else
  echo "Bumping desktop version: $CURRENT_VERSION → $VERSION"
  node -e "
    const fs = require('fs');
    const p = '$DESKTOP_PKG';
    const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
    pkg.version = '$VERSION';
    fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + '\n');
  "
  git add "$DESKTOP_PKG"
  git commit -m "chore: bump desktop version to $VERSION"
fi

echo "Creating tag $TAG"
git tag "$TAG"

echo "Pushing tag $TAG to origin (triggers release build)"
git push origin main "$TAG"

echo ""
echo "Done! The release workflow will build and upload mimo-tasker-portable-win32-x64.zip"
echo "Monitor at: https://github.com/gabrieljamh/MiMo-Tasker/actions"
