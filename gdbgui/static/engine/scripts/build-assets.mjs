// Build gdbgui/static/engine/assets/ from the pinned npm packages and the checked-in headers:
//   clang.wasm, lld.wasm, sysroot.tar   copied byte-for-byte from node_modules/browsercc/dist
//   headers.tar                          deterministic ustar of include/** + vg.h (as include/vg.h)
//   manifest.json                        sha256 (hex), SRI integrity (sha256-base64) and size of each
// The loader verifies every asset against this manifest: fetch(url, {integrity}) in the browser,
// sha256 comparison in the Node harness. Run after `npm ci`:  node scripts/build-assets.mjs
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ENGINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ENGINE, "node_modules", "browsercc", "dist");
const OUT = path.join(ENGINE, "assets");

function tarHeader(name, size) {
  const h = Buffer.alloc(512, 0);
  let prefix = "", base = name;
  if (Buffer.byteLength(name) > 100) {
    const cut = name.lastIndexOf("/", 154);
    prefix = name.slice(0, cut); base = name.slice(cut + 1);
    if (Buffer.byteLength(base) > 100 || Buffer.byteLength(prefix) > 155) throw new Error("path too long for ustar: " + name);
  }
  h.write(base, 0, "utf8");
  h.write("0000644\0", 100); h.write("0000000\0", 108); h.write("0000000\0", 116);
  h.write(size.toString(8).padStart(11, "0") + "\0", 124);
  h.write("00000000000\0", 136);                // mtime 0: deterministic
  h.write("        ", 148);                      // checksum placeholder
  h.write("0", 156);
  h.write("ustar\0", 257); h.write("00", 263);
  h.write(prefix, 345, "utf8");
  let sum = 0; for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return h;
}

function buildTar(entries) {
  const parts = [];
  for (const [name, data] of entries) {
    parts.push(tarHeader(name, data.length), data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) parts.push(Buffer.alloc(pad, 0));
  }
  parts.push(Buffer.alloc(1024, 0));
  return Buffer.concat(parts);
}

function walk(dir, rel = "") {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name), r = rel ? rel + "/" + e.name : e.name;
    if (e.isDirectory()) out.push(...walk(p, r)); else if (e.isFile()) out.push(r);
  }
  return out;
}

export function headerEntries() {
  const inc = path.join(ENGINE, "include");
  const files = walk(inc).filter((f) => !f.startsWith("licenses/")).sort();
  const entries = files.map((f) => ["include/" + f, fs.readFileSync(path.join(inc, f))]);
  entries.push(["include/vg.h", fs.readFileSync(path.join(ENGINE, "vg.h"))]);
  entries.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return entries;
}

const describe = (buf) => ({
  sha256: crypto.createHash("sha256").update(buf).digest("hex"),
  integrity: "sha256-" + crypto.createHash("sha256").update(buf).digest("base64"),
  size: buf.length,
});

export function buildAssets() {
  if (!fs.existsSync(DIST)) throw new Error("node_modules/browsercc missing: run `npm ci` in " + ENGINE);
  fs.mkdirSync(OUT, { recursive: true });
  const pkg = JSON.parse(fs.readFileSync(path.join(ENGINE, "node_modules", "browsercc", "package.json"), "utf8"));
  const files = {};
  for (const f of ["clang.wasm", "lld.wasm", "sysroot.tar"]) {
    const b = fs.readFileSync(path.join(DIST, f));
    fs.writeFileSync(path.join(OUT, f), b);
    files[f] = describe(b);
  }
  const tar = buildTar(headerEntries());
  fs.writeFileSync(path.join(OUT, "headers.tar"), tar);
  files["headers.tar"] = describe(tar);
  const manifest = { version: 1, browsercc: pkg.version, files };
  fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const m = buildAssets();
  for (const [k, v] of Object.entries(m.files)) console.log(k.padEnd(12), String(v.size).padStart(10), v.sha256);
}
