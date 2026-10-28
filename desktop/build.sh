#!/bin/zsh
# Builds desktop/build/PGA 浮窗.app: the interface (ui/, Svelte) and the native shell (Sources/, Swift).
#   ./build.sh            build
#   ./build.sh --install  build, copy to ~/Applications and (re)start it
set -e
cd "$(dirname "$0")"
APP="build/PGA 浮窗.app"

if [[ ! -d ui/node_modules ]]; then (cd ui && npm install --no-audit --no-fund); fi
(cd ui && npx vite build --logLevel warn)

rm -rf "$APP"; mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
swiftc -O -swift-version 5 -target "$(uname -m)-apple-macos13" -o "$APP/Contents/MacOS/PGADesktop" Sources/*.swift \
  -framework AppKit -framework WebKit -framework Carbon
cp Info.plist "$APP/Contents/"
cp -R ui/dist "$APP/Contents/Resources/ui"
cp Resources/* "$APP/Contents/Resources/"
ICON=../src/pga/web/icons/PGA.icns; [[ -f $ICON ]] && cp "$ICON" "$APP/Contents/Resources/PGA.icns"
codesign --force --deep -s - "$APP" >/dev/null 2>&1
echo "built $APP"

if [[ "$1" == "--install" ]]; then
  pkill -x PGADesktop 2>/dev/null || true
  rm -rf ~/Applications/"PGA 浮窗.app"; cp -R "$APP" ~/Applications/
  open ~/Applications/"PGA 浮窗.app"
  echo "installed ~/Applications/PGA 浮窗.app"
fi
