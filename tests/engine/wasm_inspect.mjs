// Minimal WebAssembly binary inspector used by tests: reads the memory section limits and the
// initial value of the first mutable i32 global (wasm-ld's __stack_pointer) so a test can prove
// the linker flags (--max-memory, --stack-first, -z stack-size) actually took effect.
// Only the sections needed are decoded; everything else is skipped by length.

function leb(buf, pos) {
  let result = 0, shift = 0, b;
  do { b = buf[pos++]; result += (b & 0x7f) * 2 ** shift; shift += 7; } while (b & 0x80);
  return [result, pos];
}
function sleb(buf, pos) {
  let result = 0, shift = 0, b;
  do { b = buf[pos++]; result |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
  if (shift < 32 && (b & 0x40)) result |= -1 << shift;
  return [result, pos];
}

/** @param {Uint8Array} bytes */
export function inspectWasm(bytes) {
  if (bytes[0] !== 0 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) throw new Error("not wasm");
  let pos = 8;
  const out = { memory: null, globals: [], importedMemory: false };
  while (pos < bytes.length) {
    const id = bytes[pos++];
    let size; [size, pos] = leb(bytes, pos);
    const end = pos + size;
    if (id === 5) { // memory section
      let n, p = pos; [n, p] = leb(bytes, p);
      const flags = bytes[p++];
      let min, max = null; [min, p] = leb(bytes, p);
      if (flags & 1) [max, p] = leb(bytes, p);
      out.memory = { count: n, minPages: min, maxPages: max };
    } else if (id === 6) { // global section
      let n, p = pos; [n, p] = leb(bytes, p);
      for (let i = 0; i < n; i++) {
        const type = bytes[p++], mut = bytes[p++];
        const op = bytes[p++];
        let value = null;
        if (op === 0x41) [value, p] = sleb(bytes, p);            // i32.const
        else if (op === 0x42) { while (bytes[p] & 0x80) p++; p++; } // i64.const (skip)
        else if (op === 0x23) { let g; [g, p] = leb(bytes, p); value = { globalGet: g }; }
        else if (op === 0x43) p += 4; else if (op === 0x44) p += 8;
        if (bytes[p++] !== 0x0b) throw new Error("unsupported global init expr");
        out.globals.push({ type, mutable: mut === 1, value });
      }
    } else if (id === 2) { // import section: detect imported memory
      let n, p = pos; [n, p] = leb(bytes, p);
      for (let i = 0; i < n; i++) {
        let l; [l, p] = leb(bytes, p); p += l; [l, p] = leb(bytes, p); p += l;
        const kind = bytes[p++];
        if (kind === 0) { [, p] = leb(bytes, p); }
        else if (kind === 1) { p++; const f = bytes[p++]; [, p] = leb(bytes, p); if (f & 1) [, p] = leb(bytes, p); }
        else if (kind === 2) { out.importedMemory = true; const f = bytes[p++]; [, p] = leb(bytes, p); if (f & 1) [, p] = leb(bytes, p); }
        else if (kind === 3) { p += 2; }
      }
    }
    pos = end;
  }
  const sp = out.globals.find((g) => g.type === 0x7f && g.mutable && typeof g.value === "number");
  out.stackPointerInit = sp ? sp.value : null;
  return out;
}
