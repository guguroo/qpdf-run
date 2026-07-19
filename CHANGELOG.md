# Changelog

## [0.3.0] - 2026-07-19

- Rebuilt the vendored qpdf WASM runtime with growable memory
  (`-sALLOW_MEMORY_GROWTH`, 64MB initial heap, 1GB maximum). The previous
  binary had a fixed 16.375MB heap and aborted with `Aborted(OOM)` on
  `--encrypt`/`--decrypt`/`--linearize` inputs larger than roughly 6-8MB.
- Added a reproducible build pipeline for the runtime
  (`scripts/wasm/build.sh`, qpdf 11.10.0 + zlib 1.3.1 + libjpeg-turbo 3.0.4
  built with the pinned `emscripten/emsdk:3.1.73` docker image) and
  verification scripts (`scripts/check-wasm-memory.mjs`,
  `scripts/wasm-selftest.mjs`). Provenance is documented in
  `vendor/README.md`.

## [0.2.3] - 2026-05-12

- Allow inspection commands that produce stdout but no output file.
- Flush pending Emscripten TTY stdout/stderr after qpdf runs so stream inspection output without a trailing newline is returned.

## [0.2.2] - 2026-05-12

- Treat QPDF exit code `3` as a successful run with warnings while preserving missing-output failures.
- Improve warning extraction for QPDF stderr lines prefixed with the program name.
- Include the QPDF exit code on missing-output errors after warning exits.

## [0.2.0] - 2026-05-06

- Added bundler-safe asset subpath exports: `qpdf-run/worker`, `qpdf-run/qpdf.js`, and `qpdf-run/qpdf.wasm`.
- Updated the browser runner defaults to resolve vendored qpdf runtime files through explicit file URLs instead of a package directory URL.
