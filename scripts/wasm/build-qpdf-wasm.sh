#!/usr/bin/env bash
# Builds the vendored qpdf WASM runtime (vendor/qpdf/lib/qpdf.js + qpdf.wasm)
# from source with the Emscripten SDK.
#
# This script expects to run INSIDE the emscripten/emsdk container.
# Use scripts/wasm/build.sh from the host, which wraps the docker invocation.
#
# Key difference from the previously vendored binary: the WASM linear memory
# is growable (-sALLOW_MEMORY_GROWTH). The old binary was built with a fixed
# 16.375MB heap (initial == max), so any qpdf command on inputs larger than
# roughly 6-8MB aborted with "Aborted(OOM)".
set -euo pipefail

QPDF_VERSION=${QPDF_VERSION:-11.10.0}
ZLIB_VERSION=${ZLIB_VERSION:-1.3.1}
LIBJPEG_TURBO_VERSION=${LIBJPEG_TURBO_VERSION:-3.0.4}

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
WORK="$ROOT/build/wasm"
SRC="$WORK/sources"
PREFIX="$WORK/prefix"
OUT="$WORK/out"
JOBS=$(nproc)

# Keep the Emscripten cache inside the workspace so the container user does
# not need write access to the image's prewarmed cache (we run as the host
# uid, see build.sh). Building with -fexceptions triggers a one-time rebuild
# of a few system library variants into this cache.
export EM_CACHE="$WORK/.emscripten-cache"

mkdir -p "$SRC" "$PREFIX" "$OUT" "$EM_CACHE"

fetch() {
  local url=$1 dest=$2
  if [ -f "$dest" ]; then
    return 0
  fi
  echo "Fetching $url"
  if command -v curl >/dev/null 2>&1; then
    curl -fL --retry 3 -o "$dest.tmp" "$url"
  elif command -v wget >/dev/null 2>&1; then
    wget -O "$dest.tmp" "$url"
  else
    python3 -c "import urllib.request,sys;urllib.request.urlretrieve(sys.argv[1],sys.argv[2])" "$url" "$dest.tmp"
  fi
  mv "$dest.tmp" "$dest"
}

# --- zlib -------------------------------------------------------------------
if [ ! -f "$PREFIX/lib/libz.a" ]; then
  fetch "https://github.com/madler/zlib/releases/download/v$ZLIB_VERSION/zlib-$ZLIB_VERSION.tar.gz" "$SRC/zlib-$ZLIB_VERSION.tar.gz"
  rm -rf "$SRC/zlib-$ZLIB_VERSION"
  tar -xzf "$SRC/zlib-$ZLIB_VERSION.tar.gz" -C "$SRC"
  (
    cd "$SRC/zlib-$ZLIB_VERSION"
    emconfigure ./configure --prefix="$PREFIX" --static
    emmake make -j"$JOBS" install
  )
fi

# --- libjpeg-turbo ----------------------------------------------------------
# qpdf requires a libjpeg API implementation for DCT stream support.
# SIMD must be disabled for the wasm target.
if [ ! -f "$PREFIX/lib/libjpeg.a" ] || [ ! -f "$PREFIX/include/jpeglib.h" ]; then
  fetch "https://github.com/libjpeg-turbo/libjpeg-turbo/releases/download/$LIBJPEG_TURBO_VERSION/libjpeg-turbo-$LIBJPEG_TURBO_VERSION.tar.gz" "$SRC/libjpeg-turbo-$LIBJPEG_TURBO_VERSION.tar.gz"
  rm -rf "$SRC/libjpeg-turbo-$LIBJPEG_TURBO_VERSION"
  tar -xzf "$SRC/libjpeg-turbo-$LIBJPEG_TURBO_VERSION.tar.gz" -C "$SRC"
  emcmake cmake -S "$SRC/libjpeg-turbo-$LIBJPEG_TURBO_VERSION" -B "$WORK/libjpeg-build" \
    -DCMAKE_BUILD_TYPE=Release \
    -DENABLE_SHARED=0 \
    -DENABLE_STATIC=1 \
    -DWITH_SIMD=0 \
    -DWITH_TURBOJPEG=0
  cmake --build "$WORK/libjpeg-build" --target jpeg-static -j"$JOBS"
  # Copy the lib and headers directly instead of `cmake --install`, which
  # would also try to install CLI tools we did not build.
  mkdir -p "$PREFIX/lib" "$PREFIX/include"
  cp "$WORK/libjpeg-build/libjpeg.a" "$PREFIX/lib/"
  cp "$SRC/libjpeg-turbo-$LIBJPEG_TURBO_VERSION"/{jpeglib.h,jerror.h,jmorecfg.h} "$PREFIX/include/"
  cp "$WORK/libjpeg-build/jconfig.h" "$PREFIX/include/"
fi

# --- qpdf -------------------------------------------------------------------
fetch "https://github.com/qpdf/qpdf/releases/download/v$QPDF_VERSION/qpdf-$QPDF_VERSION.tar.gz" "$SRC/qpdf-$QPDF_VERSION.tar.gz"
if [ ! -d "$SRC/qpdf-$QPDF_VERSION" ]; then
  tar -xzf "$SRC/qpdf-$QPDF_VERSION.tar.gz" -C "$SRC"
fi

# Link flags for the qpdf CLI executable. These define the contract with
# src/worker.js, which imports the glue in a Web Worker and then uses the
# script-level globals FS, TTY, callMain, and EXITSTATUS:
#   - no MODULARIZE, no closure: symbols stay as top-level vars
#   - EXPORTED_RUNTIME_METHODS keeps FS/TTY/callMain from being DCE'd
#   - EXIT_RUNTIME=0 keeps the runtime alive for repeated callMain() runs
#   - memory: start at 64MB, grow on demand up to 1GB (the actual fix)
#   - -fexceptions: qpdf relies on C++ exceptions for error handling
LINK_FLAGS="-O2 -fexceptions"
LINK_FLAGS+=" -sALLOW_MEMORY_GROWTH=1"
LINK_FLAGS+=" -sINITIAL_MEMORY=67108864"
LINK_FLAGS+=" -sMAXIMUM_MEMORY=1073741824"
LINK_FLAGS+=" -sSTACK_SIZE=5242880"
LINK_FLAGS+=" -sFORCE_FILESYSTEM=1"
LINK_FLAGS+=" -sEXPORTED_RUNTIME_METHODS=callMain,FS,TTY"
LINK_FLAGS+=" -sENVIRONMENT=web,worker,node"
LINK_FLAGS+=" -sEXIT_RUNTIME=0"

emcmake cmake -S "$SRC/qpdf-$QPDF_VERSION" -B "$WORK/qpdf-build" \
  -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_SHARED_LIBS=OFF \
  -DBUILD_STATIC_LIBS=ON \
  -DBUILD_DOC=OFF \
  -DUSE_IMPLICIT_CRYPTO=OFF \
  -DREQUIRE_CRYPTO_NATIVE=ON \
  -DZLIB_H_PATH="$PREFIX/include" \
  -DZLIB_LIB_PATH="$PREFIX/lib/libz.a" \
  -DLIBJPEG_H_PATH="$PREFIX/include" \
  -DLIBJPEG_LIB_PATH="$PREFIX/lib/libjpeg.a" \
  -DCMAKE_C_FLAGS="-O2 -fexceptions" \
  -DCMAKE_CXX_FLAGS="-O2 -fexceptions" \
  -DCMAKE_EXE_LINKER_FLAGS="$LINK_FLAGS"

cmake --build "$WORK/qpdf-build" --target qpdf -j"$JOBS"

QPDF_JS=$(find "$WORK/qpdf-build" -name 'qpdf.js' -path '*qpdf*' | head -1)
QPDF_WASM="${QPDF_JS%.js}.wasm"
if [ ! -f "$QPDF_JS" ] || [ ! -f "$QPDF_WASM" ]; then
  echo "error: build did not produce qpdf.js/qpdf.wasm" >&2
  exit 1
fi

cp "$QPDF_JS" "$OUT/qpdf.js"
cp "$QPDF_WASM" "$OUT/qpdf.wasm"

echo
echo "Build complete:"
ls -l "$OUT"
echo
echo "Next steps:"
echo "  node scripts/check-wasm-memory.mjs $OUT/qpdf.wasm"
echo "  node scripts/wasm-selftest.mjs $OUT/qpdf.js $OUT/qpdf.wasm"
echo "  cp $OUT/qpdf.js $OUT/qpdf.wasm vendor/qpdf/lib/"
