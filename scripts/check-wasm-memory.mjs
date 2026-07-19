// Parses the Memory section of a .wasm file and verifies the linear memory
// is growable. Guards against regressing to a fixed-size heap, which made
// qpdf abort with "Aborted(OOM)" on inputs larger than ~6-8MB.
//
// Usage: node scripts/check-wasm-memory.mjs <path/to/qpdf.wasm>
import { readFileSync } from 'node:fs';

const WASM_PAGE_BYTES = 65536;
const MEMORY_SECTION_ID = 5;

const wasmPath = process.argv[2];
if (!wasmPath) {
  console.error('usage: node scripts/check-wasm-memory.mjs <path/to/qpdf.wasm>');
  process.exit(2);
}

const bytes = readFileSync(wasmPath);
const memories = parseMemorySection(bytes);

if (!memories.length) {
  console.error(`${wasmPath}: no Memory section found (memory may be imported); cannot verify.`);
  process.exit(1);
}

let ok = true;
for (const memory of memories) {
  const initial = pages => `${pages} pages (${(pages * WASM_PAGE_BYTES / 1024 / 1024).toFixed(3)} MB)`;
  console.log(`${wasmPath}: memory ${memory.index}: initial ${initial(memory.initial)}, max ${memory.hasMax ? initial(memory.max) : 'none declared'}`);
  if (memory.hasMax && memory.max <= memory.initial) {
    console.error(`  FAIL: max (${memory.max}) <= initial (${memory.initial}); memory cannot grow.`);
    ok = false;
  } else {
    console.log('  OK: memory is growable.');
  }
}
process.exit(ok ? 0 : 1);

function parseMemorySection(buf) {
  const memories = [];
  let offset = 8; // skip magic + version
  while (offset < buf.length) {
    const id = buf[offset];
    offset += 1;
    let size;
    [size, offset] = readVarUint(buf, offset);
    const sectionStart = offset;
    if (id === MEMORY_SECTION_ID) {
      let count;
      [count, offset] = readVarUint(buf, sectionStart);
      for (let i = 0; i < count; i++) {
        const flags = buf[offset];
        offset += 1;
        let initial;
        [initial, offset] = readVarUint(buf, offset);
        const hasMax = Boolean(flags & 1);
        let max = 0;
        if (hasMax) {
          [max, offset] = readVarUint(buf, offset);
        }
        memories.push({ index: i, flags, initial, hasMax, max });
      }
    }
    offset = sectionStart + size;
  }
  return memories;
}

function readVarUint(buf, at) {
  let result = 0;
  let shift = 0;
  let byte;
  do {
    byte = buf[at];
    at += 1;
    result |= (byte & 0x7f) << shift;
    shift += 7;
  } while (byte & 0x80);
  return [result >>> 0, at];
}
