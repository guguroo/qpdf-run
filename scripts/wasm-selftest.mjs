// Exercises the qpdf WASM runtime under Node with progressively larger PDFs
// to verify that --encrypt, --decrypt, and --linearize succeed beyond the
// old fixed-heap limit (~6-8MB inputs aborted with "Aborted(OOM)").
//
// Loads the Emscripten glue the same way src/worker.js does in the browser:
// a global Module object is defined first, then the classic (non-module)
// script is evaluated so FS / TTY / callMain / EXITSTATUS become globals.
// Run inside the emsdk container if the host has no Node:
//   docker run --rm -v "$PWD":/src -w /src emscripten/emsdk:3.1.73 \
//     node scripts/wasm-selftest.mjs vendor/qpdf/lib/qpdf.js vendor/qpdf/lib/qpdf.wasm
//
// Options: --sizes 1,10,30 (input sizes in MB, default "1,10,30")
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';

main().catch(error => {
  console.error(error && error.stack || String(error));
  process.exit(1);
});

async function main() {
  const args = process.argv.slice(2);
  const sizesArgIndex = args.indexOf('--sizes');
  let sizesMb = [1, 10, 30];
  if (sizesArgIndex !== -1) {
    sizesMb = args.splice(sizesArgIndex, 2)[1].split(',').map(Number);
  }
  const qpdfJsPath = resolve(args[0] || 'vendor/qpdf/lib/qpdf.js');
  const qpdfWasmPath = resolve(args[1] || 'vendor/qpdf/lib/qpdf.wasm');

  const stdoutLines = [];
  const stderrLines = [];
  let resolveReady;
  const ready = new Promise(res => { resolveReady = res; });

  globalThis.require = createRequire(qpdfJsPath);
  globalThis.__dirname = dirname(qpdfJsPath);
  globalThis.Module = {
    thisProgram: 'qpdf',
    noInitialRun: true,
    print: text => stdoutLines.push(String(text)),
    printErr: text => stderrLines.push(String(text)),
    onRuntimeInitialized: () => resolveReady(),
    locateFile: (path, prefix) => path.endsWith('.wasm') ? qpdfWasmPath : prefix + path,
    quit: (status, toThrow) => {
      if (toThrow) throw toThrow;
      throw status;
    }
  };

  vm.runInThisContext(readFileSync(qpdfJsPath, 'utf8'), { filename: qpdfJsPath });
  await ready;

  const FS = globalThis.FS || globalThis.Module.FS;
  const callMain = globalThis.callMain || globalThis.Module.callMain;
  if (!FS || !callMain) {
    throw new Error('glue did not expose FS/callMain globals; worker contract is broken');
  }

  const failures = [];
  for (const sizeMb of sizesMb) {
    const input = makePdfWithPayload(sizeMb * 1024 * 1024);
    console.log(`\n== input ${sizeMb}MB (${input.length} bytes) ==`);

    const encrypted = runStep(failures, sizeMb, 'encrypt', FS, callMain, stderrLines,
      { 'in.pdf': input }, ['--encrypt', 'user', 'owner', '256', '--', 'in.pdf', 'enc.pdf'], 'enc.pdf');
    if (encrypted) {
      runStep(failures, sizeMb, 'decrypt', FS, callMain, stderrLines,
        { 'enc.pdf': encrypted }, ['--password=user', '--decrypt', '--', 'enc.pdf', 'dec.pdf'], 'dec.pdf');
    }
    runStep(failures, sizeMb, 'linearize', FS, callMain, stderrLines,
      { 'in.pdf': input }, ['--linearize', '--', 'in.pdf', 'lin.pdf'], 'lin.pdf');
  }

  console.log('');
  if (failures.length) {
    console.error(`FAIL: ${failures.length} step(s) failed: ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log('PASS: all sizes and operations succeeded.');
}

function runStep(failures, sizeMb, label, FS, callMain, stderrLines, inputs, argv, outputName) {
  const touched = Object.keys(inputs).concat([outputName]);
  for (const name of touched) {
    try {
      if (FS.analyzePath(name).exists) FS.unlink(name);
    } catch {
      // ignore
    }
  }
  for (const [name, bytes] of Object.entries(inputs)) {
    FS.createDataFile('/', name, bytes, true, false);
  }

  stderrLines.length = 0;
  let status = 0;
  let thrown = null;
  try {
    const result = callMain(argv);
    status = Number.isFinite(result) ? result : exitStatus();
  } catch (error) {
    status = exitStatus();
    if (typeof error === 'number') status = error;
    else if (!status) thrown = error;
  }

  // Exit code 3 is "completed with warnings", same as src/worker.js treats it.
  if (thrown || (status !== 0 && status !== 3)) {
    const detail = thrown ? (thrown.message || String(thrown)) : `exit ${status}`;
    console.error(`  ${label}: FAIL (${detail})`);
    if (stderrLines.length) console.error('    stderr: ' + stderrLines.slice(-3).join(' | '));
    failures.push(`${sizeMb}MB/${label}`);
    return null;
  }
  if (!FS.analyzePath(outputName).exists) {
    console.error(`  ${label}: FAIL (no output produced, exit ${status})`);
    failures.push(`${sizeMb}MB/${label}`);
    return null;
  }
  const output = FS.readFile(outputName, { encoding: 'binary' });
  console.log(`  ${label}: ok (exit ${status}, ${output.length} bytes out)`);
  return new Uint8Array(output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength));
}

function exitStatus() {
  return typeof globalThis.EXITSTATUS === 'number' ? globalThis.EXITSTATUS : 0;
}

// Builds a structurally valid single-page PDF whose page content stream is
// `payloadBytes` of random (incompressible) data, so qpdf's working set
// scales with the requested size. qpdf does not parse content streams for
// encrypt/decrypt/linearize, so arbitrary bytes are fine.
function makePdfWithPayload(payloadBytes) {
  const payload = randomBytes(payloadBytes);
  const encoder = new TextEncoder();
  const chunks = [];
  const offsets = [0];
  let position = 0;

  const push = text => {
    const bytes = typeof text === 'string' ? encoder.encode(text) : text;
    chunks.push(bytes);
    position += bytes.length;
  };
  const beginObj = () => offsets.push(position);

  push('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n');
  beginObj();
  push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  beginObj();
  push('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');
  beginObj();
  push('3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>\nendobj\n');
  beginObj();
  push(`4 0 obj\n<< /Length ${payload.length} >>\nstream\n`);
  push(payload);
  push('\nendstream\nendobj\n');

  const xrefOffset = position;
  push('xref\n0 5\n0000000000 65535 f \n');
  for (let i = 1; i <= 4; i++) {
    push(String(offsets[i]).padStart(10, '0') + ' 00000 n \n');
  }
  push(`trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const pdf = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    pdf.set(chunk, at);
    at += chunk.length;
  }
  return pdf;
}
