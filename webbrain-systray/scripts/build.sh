#!/usr/bin/env bash
# Builds WebBrain Companion for Windows, macOS and Linux from any host
# (everything is pure Go: CGO_ENABLED=0). Packages land in dist/.
#
#   VERSION=0.1.0 ./scripts/build.sh
#
# Optional: RCODESIGN=/path/to/rcodesign ad-hoc signs the macOS app bundle
# on Linux (on macOS the system codesign is used instead).
# Optional: SIGN_WINDOWS is a shell command that signs the file "$1" in place
# (Authenticode), run for both executables and the installer, e.g.
#   SIGN_WINDOWS='osslsigncode sign -pkcs12 cert.p12 -readpass pass.txt \
#     -t http://timestamp.digicert.com -in "$1" -out "$1.signed" && mv "$1.signed" "$1"'
# The Windows installer needs makensis (NSIS 3, apt install nsis).
set -euo pipefail

VERSION="${VERSION:-0.1.0}"
# Windows version resources want four numbers.
NUMVER=$(printf '%s' "$VERSION" | sed -nE 's/^([0-9]+)\.([0-9]+)\.([0-9]+).*/\1.\2.\3.0/p')
NUMVER="${NUMVER:-0.0.0.0}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/dist"
STAGE="$DIST/.stage"
NAME="WebBrain-Companion-$VERSION"
LDFLAGS="-s -w -X main.version=$VERSION"
export CGO_ENABLED=0
cd "$ROOT"

rm -rf "$STAGE"
mkdir -p "$STAGE" "$DIST"

echo "==> Windows resources (icon, manifest, version info)"
go run github.com/tc-hib/go-winres@v0.3.3 simply \
  --icon assets/icons/app.ico --manifest gui \
  --product-name "WebBrain Companion" --file-description "WebBrain Companion" \
  --product-version "$NUMVER" --file-version "$NUMVER" \
  --copyright "Copyright 2026 Emre Sokullu" --original-filename "WebBrainCompanion.exe" \
  --arch amd64,arm64 --out rsrc

build() { # goos goarch out [extra ldflags]
  echo "==> $1/$2"
  GOOS="$1" GOARCH="$2" go build -trimpath -ldflags "$LDFLAGS ${4:-}" -o "$3" .
}

sign_windows() {
  if [ -n "${SIGN_WINDOWS:-}" ]; then
    echo "   signing $(basename "$1")"
    bash -c "$SIGN_WINDOWS" _ "$1"
  fi
}

mkdir -p "$STAGE/win"
for arch in amd64 arm64; do
  build windows "$arch" "$STAGE/win/WebBrainCompanion-$arch.exe" "-H windowsgui"
  sign_windows "$STAGE/win/WebBrainCompanion-$arch.exe"
done
echo "==> Windows installer"
makensis -V2 -INPUTCHARSET UTF8 \
  -DVERSION="$VERSION" -DNUMVER="$NUMVER" \
  -DSRC_X64="$STAGE/win/WebBrainCompanion-amd64.exe" -DSRC_ARM64="$STAGE/win/WebBrainCompanion-arm64.exe" \
  -DICON="$ROOT/assets/icons/app.ico" -DLICENSE="$ROOT/LICENSE" -DREADME="$ROOT/README.md" \
  -DOUTFILE="$DIST/$NAME-windows-setup.exe" \
  packaging/windows/installer.nsi
sign_windows "$DIST/$NAME-windows-setup.exe"

echo "==> macOS universal app"
mkdir -p "$STAGE/mac"
build darwin arm64 "$STAGE/mac/companion-arm64"
build darwin amd64 "$STAGE/mac/companion-amd64"
APP="$STAGE/mac/WebBrain Companion.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
go run github.com/randall77/makefat@v0.0.0-20260406194835-1b91746796b7 "$APP/Contents/MacOS/WebBrain Companion" "$STAGE/mac/companion-arm64" "$STAGE/mac/companion-amd64"
chmod +x "$APP/Contents/MacOS/WebBrain Companion"
sed "s/__VERSION__/$VERSION/g" packaging/macos/Info.plist > "$APP/Contents/Info.plist"
cp assets/icons/app.icns "$APP/Contents/Resources/app.icns"
printf 'APPL????' > "$APP/Contents/PkgInfo"
if command -v codesign >/dev/null 2>&1; then
  codesign --force --deep -s - "$APP"
elif [ -n "${RCODESIGN:-}" ]; then
  "$RCODESIGN" sign "$APP" >/dev/null
else
  echo "   (not signed: set RCODESIGN or build on macOS)"
fi
cp README.md LICENSE "$STAGE/mac/"
(cd "$STAGE/mac" && rm -f "$DIST/$NAME-macos-universal.zip" && zip -qry "$DIST/$NAME-macos-universal.zip" "WebBrain Companion.app" README.md LICENSE)

for arch in amd64 arm64; do
  label=$([ "$arch" = amd64 ] && echo x64 || echo arm64)
  dir="$STAGE/linux-$label/webbrain-companion"
  mkdir -p "$dir"
  build linux "$arch" "$dir/webbrain-companion"
  cp packaging/linux/webbrain-companion.desktop "$dir/"
  cp assets/icons/app-256.png "$dir/webbrain-companion.png"
  cp README.md LICENSE "$dir/"
  tar -C "$STAGE/linux-$label" -czf "$DIST/$NAME-linux-$label.tar.gz" webbrain-companion
done

rm -rf "$STAGE"
(cd "$DIST" && sha256sum "$NAME"-*.exe "$NAME"-*.zip "$NAME"-*.tar.gz > "$NAME-SHA256SUMS.txt")
echo "==> done"
ls -lh "$DIST"
