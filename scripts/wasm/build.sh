#!/usr/bin/env bash
# Host-side wrapper: builds the vendored qpdf WASM runtime inside the
# pinned Emscripten SDK docker image. Produces build/wasm/out/qpdf.{js,wasm}.
#
# Usage:
#   bash scripts/wasm/build.sh
#
# Requirements: docker. The image below is the pinned toolchain; changing it
# changes the generated JS glue, so bump it deliberately and re-run the
# verification scripts (see vendor/README.md).
set -euo pipefail

IMAGE=${QPDF_WASM_EMSDK_IMAGE:-emscripten/emsdk:3.1.73}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)

docker run --rm \
  -u "$(id -u):$(id -g)" \
  -e HOME=/tmp \
  -v "$ROOT":/src \
  -w /src \
  "$IMAGE" \
  bash scripts/wasm/build-qpdf-wasm.sh
