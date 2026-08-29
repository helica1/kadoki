#!/bin/bash
# Minimal ffmpeg static libs for the Kadoki mkv->mp4 remuxer.
# Usage: build-remux.sh xros|macos
set -e
SCRATCH="$(cd "$(dirname "$0")" && pwd)"
SRC="$SCRATCH/ffmpeg-7.1"
PLAT="$1"
if [ "$PLAT" = "xros" ]; then
  SDK=$(xcrun --sdk xros --show-sdk-path)
  TARGET="arm64-apple-xros2.0"
  OUT="$SCRATCH/out-xros"
else
  SDK=$(xcrun --sdk macosx --show-sdk-path)
  TARGET="arm64-apple-macos13.0"
  OUT="$SCRATCH/out-macos"
fi
BUILD="$OUT-build"
rm -rf "$BUILD" "$OUT"; mkdir -p "$BUILD" "$OUT"
cd "$BUILD"
CC="$(xcrun -f clang)"
CFLAGS="-arch arm64 -isysroot $SDK -target $TARGET -O2"
"$SRC/configure" \
  --prefix="$OUT" \
  --enable-cross-compile --arch=arm64 --target-os=darwin \
  --cc="$CC" --sysroot="$SDK" \
  --extra-cflags="$CFLAGS" --extra-ldflags="$CFLAGS" \
  --disable-everything \
  --disable-programs --disable-doc --disable-debug \
  --disable-avdevice --disable-swscale --disable-swresample \
  --disable-avfilter --disable-network --disable-asm \
  --disable-audiotoolbox --disable-videotoolbox \
  --disable-iconv --disable-securetransport --disable-coreimage \
  --enable-zlib \
  --enable-demuxer=matroska \
  --enable-muxer=mp4,mov,ipod \
  --enable-protocol=file \
  --enable-parser=h264,hevc,aac,ac3 \
  --enable-bsf=extract_extradata \
  --enable-small \
  --disable-xlib --disable-sdl2
make -j8 install >/dev/null
echo "== built =="
ls "$OUT/lib"
