// @ts-check
// Compiler driver: runs the wasm clang/lld (browsercc 0.1.1, vendored emscripten glue) on an
// in-memory filesystem. Used inside pipeline.worker.js; also imported directly by Node tests.
//
// The host hands over already-compiled WebAssembly.Module objects for clang and lld and the
// sysroot/header tarballs (all integrity-checked by the loader in index.js / node_driver.mjs), so
// this code never fetches anything.
import Clang from "./vendor/browsercc/clang.js";
import LLD from "./vendor/browsercc/lld.js";

/**
 * Parse a POSIX ustar archive. Returns regular files only; content is a view (no copy).
 * @param {ArrayBuffer | Uint8Array} tar
 * @returns {Array<{ name: string, content: Uint8Array }>}
 */
export function parseTar(tar) {
  const data = tar instanceof Uint8Array ? tar : new Uint8Array(tar);
  const td = new TextDecoder("utf-8");
  const str = (/** @type {number} */ a, /** @type {number} */ b) => td.decode(data.subarray(a, b)).replace(/\0.*$/s, "");
  /** @type {Array<{ name: string, content: Uint8Array }>} */
  const out = [];
  let off = 0;
  while (off + 512 <= data.length) {
    const name = str(off, off + 100);
    if (!name) break;
    const size = parseInt(str(off + 124, off + 136).trim(), 8) || 0;
    const type = String.fromCharCode(data[off + 156] || 48);
    const prefix = str(off + 345, off + 500);
    const full = (prefix ? prefix + "/" : "") + name;
    if ((type === "0" || type === "\0") && !full.endsWith("/")) {
      if (full.split("/").includes("..") || full.startsWith("/")) throw new Error("tar: unsafe path " + full);
      out.push({ name: full, content: data.subarray(off + 512, off + 512 + size) });
    }
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

export const MAX_CLANG_STDOUT = 64 * 1024 * 1024; // AST JSON of the user namespace (~1 MB for a lesson)
export const MAX_CLANG_STDERR = 1024 * 1024;

/** Line collector with a byte (UTF-16 unit) cap; lines beyond the cap are dropped and flagged. @param {number} cap */
function boundedText(cap) {
  /** @type {string[]} */
  const parts = [];
  let size = 0, overflow = false;
  return {
    add: (/** @type {string} */ s) => { if (overflow) return; if (size + s.length + 1 > cap) { overflow = true; return; } parts.push(s); size += s.length + 1; },
    text: () => parts.join("\n") + (parts.length ? "\n" : ""),
    get overflow() { return overflow; },
  };
}

/** Instantiate an emscripten module from a precompiled WebAssembly.Module (no fetch). */
const instantiateFrom = (/** @type {WebAssembly.Module} */ mod) =>
  (/** @type {WebAssembly.Imports} */ imports, /** @type {Function} */ cb) => {
    WebAssembly.instantiate(mod, imports).then((inst) => cb(inst, mod));
    return {};
  };

export class Driver {
  /**
   * @param {{ clangModule: WebAssembly.Module, lldModule: WebAssembly.Module,
   *           sysroot: ArrayBuffer | Uint8Array, headers: ArrayBuffer | Uint8Array }} a
   */
  constructor({ clangModule, lldModule, sysroot, headers }) {
    this.clangModule = clangModule;
    this.lldModule = lldModule;
    this.files = [...parseTar(sysroot), ...parseTar(headers)];
    /** @type {Set<string>} */
    const dirs = new Set();
    for (const f of this.files) {
      const parts = f.name.split("/");
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
    }
    this.dirs = [...dirs].sort((a, b) => a.length - b.length);
    /** @type {Map<string, { cc1: string[], ld: string[] | null }>} */
    this.argCache = new Map();
    const vg = this.files.find((f) => f.name === "include/vg.h");
    this.vgH = vg ? new TextDecoder().decode(vg.content) : "";
  }

  /** @param {"clang" | "lld"} which @param {{ print?: (s: string) => void, printErr?: (s: string) => void }} io */
  async instance(which, io = {}) {
    const factory = which === "clang" ? Clang : LLD;
    const mod = which === "clang" ? this.clangModule : this.lldModule;
    return /** @type {any} */ (await factory({
      thisProgram: which === "clang" ? "clang++" : "wasm-ld",
      print: io.print || (() => {}),
      printErr: io.printErr || (() => {}),
      instantiateWasm: instantiateFrom(mod),
      locateFile: (/** @type {string} */ p) => p,
    }));
  }

  /** Write the sysroot + headers + extra files into an instance's MEMFS. @param {any} inst @param {Record<string, string | Uint8Array>} extra */
  mount(inst, extra = {}) {
    const FS = inst.FS;
    for (const d of this.dirs) { try { FS.mkdir("/" + d); } catch { /* exists */ } }
    for (const f of this.files) FS.writeFile("/" + f.name, f.content);
    for (const [name, content] of Object.entries(extra)) {
      const parts = name.split("/");
      if (parts.length > 1) FS.mkdirTree("/" + parts.slice(0, -1).join("/"));
      FS.writeFile("/" + name, content);
    }
  }

  /**
   * Ask the clang driver (-###) for the cc1 and wasm-ld command lines. Cached per (input, flags):
   * the answer depends only on those, and each driver run costs ~80 ms.
   * @param {string} input @param {string[]} flags
   */
  async commands(input, flags) {
    const key = JSON.stringify([input, flags]);
    const hit = this.argCache.get(key);
    if (hit) return hit;
    let err = "";
    const c = await this.instance("clang", { printErr: (d) => { err += d + "\n"; } });
    c.FS.mkdirTree("/lib/wasm32-wasi"); c.FS.mkdirTree("/include/c++/v1");
    c.FS.writeFile("/lib/wasm32-wasi/crt1-command.o", new Uint8Array(0));
    c.FS.writeFile("/lib/wasm32-wasi/crt1-reactor.o", new Uint8Array(0));
    c.FS.writeFile("/" + input, "");
    c.callMain([input, ...flags, "-###"]);
    const lines = err.split("\n");
    const get = (/** @type {string} */ k) => {
      const line = lines.find((l) => l.includes(k));
      if (!line) return null;
      return (line.match(/"([^"]*)"/g) || []).map((s) => s.slice(1, -1)).slice(1);
    };
    const cc1 = get("-cc1");
    if (!cc1) throw new Error("clang driver failed: " + err.slice(0, 500));
    const res = { cc1, ld: get("wasm-ld") };
    this.argCache.set(key, res);
    return res;
  }

  /**
   * Run one cc1 invocation. @param {string[]} args @param {Record<string, string | Uint8Array>} files
   * @param {{ keep?: string }} [o]
   */
  async cc1(args, files, o = {}) {
    // Bounded capture of clang's stdout (the AST JSON) and stderr (diagnostics): a pathological
    // program must not be able to exhaust the worker's heap through compiler output.
    const out = boundedText(MAX_CLANG_STDOUT), err = boundedText(MAX_CLANG_STDERR);
    const c = await this.instance("clang", { print: out.add, printErr: err.add });
    this.mount(c, files);
    let code;
    // callMain() mutates its argument (args.unshift(thisProgram)): always pass a copy.
    try { code = c.callMain([...args]); } catch (e) { code = 1; err.add("clang crashed: " + String(/** @type {any} */ (e)?.message || e)); }
    /** @type {Uint8Array | null} */
    let kept = null;
    if (code === 0 && o.keep) kept = c.FS.readFile(o.keep, { encoding: "binary" });
    if (out.overflow) { code = code || 1; err.add(`compiler output exceeded ${MAX_CLANG_STDOUT} bytes (program too large to analyse)`); }
    return { code, out: out.text(), err: err.text(), kept, overflow: out.overflow };
  }

  /** clang -fsyntax-only -ast-dump=json (optionally filtered). */
  async astJson(source, { flags = /** @type {string[]} */ ([]), filter = /** @type {string | null} */ (null), files = {} } = {}) {
    const all = [...flags, "-fsyntax-only", "-Xclang", "-ast-dump=json", ...(filter ? ["-Xclang", `-ast-dump-filter=${filter}`] : [])];
    const { cc1 } = await this.commands("main.cpp", all);
    return this.cc1(cc1, { ...files, "main.cpp": source });
  }

  /** clang -fsyntax-only (diagnostics only). */
  async syntaxCheck(source, { flags = /** @type {string[]} */ ([]), files = {} } = {}) {
    const { cc1 } = await this.commands("main.cpp", [...flags, "-fsyntax-only"]);
    return this.cc1(cc1, { ...files, "main.cpp": source });
  }

  /**
   * Compile + link to a wasm binary.
   * @param {string} source @param {{ flags: string[], files?: Record<string, string | Uint8Array>, onStage?: (s: string) => void }} o
   */
  async compileLink(source, { flags, files = {}, onStage = () => {} }) {
    const { cc1, ld } = await this.commands("main.cpp", flags);
    if (!ld) throw new Error("clang driver produced no link step");
    const objName = cc1[cc1.indexOf("-o") + 1];
    onStage("compile");
    const c = await this.cc1(cc1, { ...files, "main.cpp": source }, { keep: objName });
    if (c.code !== 0 || !c.kept) return { ok: false, stage: "compile", log: c.err };
    onStage("link");
    let err = "";
    const l = await this.instance("lld", { printErr: (d) => { err += d + "\n"; } });
    this.mount(l, {});
    l.FS.mkdirTree("/" + objName.split("/").slice(0, -1).join("/"));
    l.FS.writeFile(objName.startsWith("/") ? objName : "/" + objName, c.kept);
    let code;
    try { code = l.callMain([...ld]); } catch (e) { code = 1; err += "\nlld crashed: " + String(/** @type {any} */ (e)?.message || e); }
    if (code !== 0) return { ok: false, stage: "link", log: c.err + err };
    const outName = ld[ld.indexOf("-o") + 1];
    const wasm = /** @type {Uint8Array} */ (l.FS.readFile(outName, { encoding: "binary" }));
    return { ok: true, wasm, log: c.err + err };
  }

  /**
   * Build a precompiled header from `headerText` (written as /pch_src.h). Timestamps are not
   * recorded (-fno-pch-timestamp) so consumers can validate inputs by content instead.
   * @param {string} headerText @param {string[]} flags
   */
  async buildPch(headerText, flags) {
    const { cc1 } = await this.commands("pch_src.h", ["-x", "c++-header", ...flags, "-Xclang", "-fno-pch-timestamp", "-o", "out.pch"]);
    const r = await this.cc1(cc1, { "pch_src.h": headerText }, { keep: "/out.pch" });
    if (r.code !== 0 || !r.kept) throw new Error("PCH build failed: " + r.err.slice(0, 800));
    return r.kept;
  }
}
