# Vendor Assets

`qpdf/` contains the vendored qpdf WASM browser runtime used by `qpdf-run`.

The package currently resolves these assets through explicit runner options:

- `assetBaseUrl`
- `qpdfJsUrl`
- `wasmUrl`

The published package should keep these assets addressable without relying on an application-specific public path.

## Provenance

`qpdf/lib/qpdf.js` and `qpdf/lib/qpdf.wasm` are built from source by this
repository's build pipeline (`scripts/wasm/build.sh`):

- qpdf 11.10.0 (https://github.com/qpdf/qpdf, Apache License 2.0), using
  qpdf's native crypto backend
- zlib 1.3.1
- libjpeg-turbo 3.0.4 (SIMD disabled for the wasm target)
- Emscripten SDK 3.1.73 via the pinned docker image `emscripten/emsdk:3.1.73`

Key link settings (see `scripts/wasm/build-qpdf-wasm.sh` for the full list):

- `-sALLOW_MEMORY_GROWTH=1` with `-sINITIAL_MEMORY=64MB` and
  `-sMAXIMUM_MEMORY=1GB`. Earlier releases shipped a binary with a fixed
  16.375MB heap, which aborted with `Aborted(OOM)` on inputs larger than
  roughly 6-8MB.
- Classic (non-`MODULARIZE`, non-closure) output with
  `-sEXPORTED_RUNTIME_METHODS=callMain,FS,TTY` and `-sEXIT_RUNTIME=0`, which
  is the contract `src/worker.js` relies on: after `importScripts(qpdf.js)`
  the worker uses the script-level globals `FS`, `TTY`, `callMain`, and
  `EXITSTATUS`, and calls `callMain()` repeatedly on one runtime.

## Rebuilding

```bash
bash scripts/wasm/build.sh   # requires docker; writes build/wasm/out/
node scripts/check-wasm-memory.mjs build/wasm/out/qpdf.wasm
node scripts/wasm-selftest.mjs build/wasm/out/qpdf.js build/wasm/out/qpdf.wasm
cp build/wasm/out/qpdf.js build/wasm/out/qpdf.wasm vendor/qpdf/lib/
```

If the host has no Node, run the two verification scripts inside the same
docker image:

```bash
docker run --rm -v "$PWD":/src -w /src emscripten/emsdk:3.1.73 \
  node scripts/wasm-selftest.mjs vendor/qpdf/lib/qpdf.js vendor/qpdf/lib/qpdf.wasm
```

## Licensing

qpdf is licensed under the Apache License 2.0; zlib under the zlib license;
libjpeg-turbo under the IJG, BSD-3-Clause, and zlib licenses. The compiled
`qpdf.wasm`/`qpdf.js` artifacts are redistributed here under those upstream
terms alongside this package's MIT-licensed JavaScript.
