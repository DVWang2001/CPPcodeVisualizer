// Node harness for the browser engine: runs the SAME index.js / pipeline.worker.js / exec.worker.js
// code, replacing only the three browser adapters:
//   loadAssets   -> read gdbgui/static/engine/assets/* from disk and verify each file's sha256
//                   against assets/manifest.json (the browser uses fetch(url, {integrity}))
//   createWorker -> node:worker_threads running node_worker_bootstrap.mjs
//   pchStore     -> "memory" (IndexedDB does not exist in Node)
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Worker } from "node:worker_threads";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadEngine, validateManifest } from "../../gdbgui/static/engine/index.js";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const ENGINE = path.join(ROOT, "gdbgui", "static", "engine");
export const ASSETS = path.join(ENGINE, "assets");
const BOOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "node_worker_bootstrap.mjs");

/** Wrap a node Worker in the subset of the DOM Worker interface index.js uses. */
class WebLikeWorker {
  constructor(file, resourceLimits) {
    this.onmessage = null;
    this.onerror = null;
    this.terminated = false;
    this.w = new Worker(BOOT, { workerData: { url: pathToFileURL(file).href }, resourceLimits });
    this.w.on("message", (data) => this.onmessage && this.onmessage({ data }));
    this.w.on("error", (e) => this.onerror && this.onerror(e));
    this.w.on("exit", (code) => { if (!this.terminated && this.onerror) this.onerror(new Error("worker exited with code " + code)); });
  }
  postMessage(m, transfer) { this.w.postMessage(m, transfer || []); }
  terminate() { this.terminated = true; return this.w.terminate(); }
}

export function readVerified(name, manifest, dir = ASSETS) {
  const buf = fs.readFileSync(path.join(dir, name));
  const sha = crypto.createHash("sha256").update(buf).digest("hex");
  const want = manifest.files[name];
  if (!want || sha !== want.sha256 || buf.length !== want.size) {
    throw new Error(`asset integrity check failed for ${name}: sha256 ${sha} != manifest ${want && want.sha256}`);
  }
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

/** @param {{ pchStore?: "memory" | "none", execResourceLimits?: object, assetsDir?: string }} [o] */
export function createNodeEnv(o = {}) {
  return {
    pchStore: o.pchStore || "memory",
    async loadAssets() {
      if (!fs.existsSync(path.join(ASSETS, "manifest.json"))) {
        throw new Error("engine assets missing: run `npm ci && node scripts/build-assets.mjs` in " + ENGINE);
      }
      const manifest = validateManifest(JSON.parse(fs.readFileSync(path.join(ASSETS, "manifest.json"), "utf8")));
      const [clangModule, lldModule] = await Promise.all([
        WebAssembly.compile(readVerified("clang.wasm", manifest)),
        WebAssembly.compile(readVerified("lld.wasm", manifest)),
      ]);
      return {
        clangModule, lldModule,
        sysroot: readVerified("sysroot.tar", manifest),
        headers: readVerified("headers.tar", manifest),
        hashes: { clang: manifest.files["clang.wasm"].sha256, sysroot: manifest.files["sysroot.tar"].sha256, headers: manifest.files["headers.tar"].sha256 },
      };
    },
    createWorker(kind) {
      return new WebLikeWorker(path.join(ENGINE, kind === "pipeline" ? "pipeline.worker.js" : "exec.worker.js"), kind === "exec" ? o.execResourceLimits : undefined);
    },
  };
}

/** Load an engine for Node tests. */
export async function loadNodeEngine(o = {}) {
  return loadEngine({ env: createNodeEnv(o), pchLimits: o.pchLimits });
}

// CLI: node tests/engine/node_driver.mjs prog.cpp [input.txt]
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [src, inp] = process.argv.slice(2);
  const eng = await loadNodeEngine();
  const r = await eng.runProgram(fs.readFileSync(src, "utf8"), inp ? fs.readFileSync(inp, "utf8") : "");
  console.log(JSON.stringify({ ok: r.ok, exit: r.exit, errors: r.errors, steps: r.steps.length, stdout: r.stdout, timings: r.timings, pchFrom: r.pchFrom }, null, 1));
  eng.dispose();
}
