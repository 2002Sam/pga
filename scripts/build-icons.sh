#!/usr/bin/env bash
# Rebuild web / PWA / macOS icons: the approved headshot on an orange rounded tile.
# Requires macOS sips and iconutil; no image-generation API or Python packages.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HEAD="$ROOT/docs/media/pga-witch-cat-head.png"
SOURCE="$ROOT/docs/media/pga-witch-cat-logo-orange.png"        # full tile: web, favicon, PWA
MAC="$ROOT/docs/media/pga-witch-cat-logo-orange-macos.png"     # Apple 824/1024 grid: Dock icon
OUT="$ROOT/src/pga/web/icons"
command -v sips >/dev/null
command -v iconutil >/dev/null
mkdir -p "$OUT"
[[ "${1:-}" == --compose ]] && python3 "$ROOT/scripts/make-orange-logo.py" "$HEAD" "$SOURCE" "$MAC"   # needs Pillow
sips -z 1024 1024 "$SOURCE" --out "$OUT/logo.png" >/dev/null
for entry in logo-128:128 favicon-16:16 favicon-32:32 favicon-48:48 icon-192:192 icon-512:512 apple-touch-icon:180; do
  name="${entry%:*}"; size="${entry#*:}"
  sips -z "$size" "$size" "$SOURCE" --out "$OUT/$name.png" >/dev/null
done
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir "$WORK/PGA.iconset"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$MAC" --out "$WORK/PGA.iconset/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -z "$double" "$double" "$MAC" --out "$WORK/PGA.iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$WORK/PGA.iconset" -o "$OUT/PGA.icns"
echo "Rebuilt PGA icons in $OUT"
