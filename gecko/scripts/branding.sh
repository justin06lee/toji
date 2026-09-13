#!/bin/sh
# Regenerates Toji's branding images in gecko/overlay/browser/branding/toji
# from assets/icon.png. The outputs are committed; rerun this only when the
# icon changes. Needs macOS (sips, iconutil, actool) and rsvg-convert.
set -eu

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
SRC="$ROOT/assets/icon.png"
OUT="$ROOT/gecko/overlay/browser/branding/toji"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

png() { sips -z "$2" "$2" "$SRC" --out "$1" >/dev/null; }

# Linux / chrome icons.
for s in 16 22 24 32 48 64 128 256; do png "$OUT/default$s.png" "$s"; done

# About dialog and private-window logos.
png "$OUT/content/about-logo.png" 192
png "$OUT/content/about-logo@2x.png" 384
cp "$OUT/content/about-logo.png" "$OUT/content/about-logo-private.png"
cp "$OUT/content/about-logo@2x.png" "$OUT/content/about-logo-private@2x.png"
png "$TMP/logo512.png" 512
B64=$(base64 < "$TMP/logo512.png" | tr -d '\n')
cat > "$OUT/content/about-logo.svg" <<EOF
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="512" height="512" viewBox="0 0 512 512"><image width="512" height="512" xlink:href="data:image/png;base64,$B64"/></svg>
EOF

# about.png (300x236): the icon centred on the dialog's dark ground.
cat > "$TMP/about.svg" <<EOF
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="300" height="236"><rect width="300" height="236" fill="#0a0a0a"/><image x="68" y="36" width="164" height="164" xlink:href="data:image/png;base64,$B64"/></svg>
EOF
rsvg-convert "$TMP/about.svg" -o "$OUT/content/about.png"

# macOS .icns for the app and its documents.
ICONSET="$TMP/toji.iconset"
mkdir "$ICONSET"
for s in 16 32 128 256 512; do
  png "$ICONSET/icon_${s}x${s}.png" "$s"
  png "$ICONSET/icon_${s}x${s}@2x.png" $((s * 2))
done
iconutil -c icns "$ICONSET" -o "$OUT/firefox.icns"
cp "$OUT/firefox.icns" "$OUT/document.icns"
cp "$OUT/firefox.icns" "$OUT/disk.icns"

# Assets.car: the asset catalog macOS 11+ prefers (CFBundleIconName AppIcon).
CAT="$TMP/Assets.xcassets"
SET="$CAT/AppIcon.appiconset"
mkdir -p "$SET"
printf '{"info":{"version":1,"author":"xcode"}}' > "$CAT/Contents.json"
{
  printf '{"images":['
  sep=""
  for s in 16 32 128 256 512; do
    for scale in 1 2; do
      px=$((s * scale))
      png "$SET/icon_${s}_${scale}x.png" "$px"
      printf '%s{"idiom":"mac","size":"%sx%s","scale":"%sx","filename":"icon_%s_%sx.png"}' "$sep" "$s" "$s" "$scale" "$s" "$scale"
      sep=","
    done
  done
  printf '],"info":{"version":1,"author":"xcode"}}'
} > "$SET/Contents.json"
mkdir -p "$TMP/car"
xcrun actool "$CAT" --compile "$TMP/car" --platform macosx \
  --minimum-deployment-target 10.15 --app-icon AppIcon \
  --output-partial-info-plist "$TMP/partial.plist" >/dev/null
cp "$TMP/car/Assets.car" "$OUT/Assets.car"

# Windows .ico files the shared jar.mn and moz.build list.
sips -s format ico -z 256 256 "$SRC" --out "$OUT/document.ico" >/dev/null
cp "$OUT/document.ico" "$OUT/firefox.ico"

# DMG background: plain, the Applications arrow drawn by Toji's own hand.
cat > "$TMP/bg.svg" <<'EOF'
<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="880"><rect width="1440" height="880" fill="#fafafa"/><path d="M600 388h130m-26-26 26 26-26 26" fill="none" stroke="#a3a3a3" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/></svg>
EOF
rsvg-convert "$TMP/bg.svg" -o "$OUT/background.png"

echo "branding written to $OUT"
