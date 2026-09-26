# vgdb in-browser engine (milestone S1)

Instruments, compiles (wasm clang/lld from `browsercc` 0.1.1) and runs a student's C++17 program
inside the browser, and returns a GDB-like stop trace plus the program's output. S1 is a
self-contained package: it is **not** wired into the UI, the Flask server, the Dockerfile or the
production machine (that is S2/S3+). Contract: `docs/superpowers/plans/2026-09-26-S1-engine-package-contract.md`.

Plain ES modules with JSDoc + `// @ts-check`, no bundler (decision D10). The two workers are static
same-origin files, never `blob:` URLs, so each can be served with its own CSP.

## Setup

```sh
cd gdbgui/static/engine
npm ci                               # exact pins: browsercc 0.1.1, @bjorn3/browser_wasi_shim 0.4.2 (lockfile has sha512)
node scripts/build-assets.mjs        # -> assets/{clang.wasm,lld.wasm,sysroot.tar,headers.tar,manifest.json}
```

`node_modules/` and `assets/` (≈95 MB) are git-ignored. `build-assets` copies the three binaries
byte-for-byte from the pinned package, packs `include/**` + `vg.h` into a deterministic
`headers.tar` (mtime 0, sorted), and writes `manifest.json` with sha256 (hex), SRI integrity
(`sha256-<base64>`) and size for each file.

## Public API (`index.js`)

```js
import { loadEngine, runProgram } from "./index.js";
const engine = await loadEngine();                 // fetch+verify assets once, start the pipeline worker
const r = await engine.runProgram(source, stdin, opts);
// or: await runProgram(source, stdin, opts)       // lazily created default engine
```

`loadEngine({ baseUrl?, env?, pchLimits? })` — `env` replaces the browser adapters (the Node test
harness passes one); `pchLimits = { maxEntries, maxBytes }`.

`runProgram(source: string, stdin?: string, opts?)`, options (unknown keys are rejected):

| option | default | meaning |
|---|---|---|
| `std` | `"c++17"` | `"c++17"`, `"c++20"` or `"c++23"` |
| `instrument` | `true` | `false` = compile and run WITHOUT instrumentation (e.g. class-based examples); `steps` is empty |
| `pch` | `true` | use the precompiled-header cache |
| `compileTimeoutMs` | 8000 | budget for the student-controlled stages (AST, compile, link); clamped to 9500 |
| `execTimeoutMs` | 5000 | wall-clock limit of the execution worker; clamped to 30000 |
| `returnWasm` | `false` | include the linked `wasm` bytes (tests) |

Result:

```js
{
  ok,            // true when the program was compiled, run and its trace decoded without errors
  engine: "wasm", version, instrumented,
  steps: [{ line, fn, depth, frame, vars, uninit? }],   // one entry per GDB-style stop
  rawSteps,      // probe records before same-line merging
  decls: { fn: { name: qualType | qualType[] } },       // AST qualType of every variable that can appear in fn's steps (incl. visible globals)
  globals: { name: qualType }, functions: { fn: { line, closeLine, params, vars } },
  uninitDecls: [{ fn, name, line, id }],
  stdout, stderr,
  exit: { reason, code, message?, stream?, trap? },
  limits: { ...applied limits }, errors: [{ kind, message, ... }],
  compileLog, timings, pchFrom: "built" | "memory" | "cache" | null, nosys?: { wasiName: calls }
}
```

`exit.reason`: `exit` (normal, `code` = exit status) · `timeout` · `output-limit` (`stream` =
stdout/stderr) · `step-limit` (200 000 probe records or 20 MB of trace) · `trace-limit` (host cap) ·
`trap` (`trap` = `abort` | `memory` | `div-zero` | `other`) · `stack-overflow` (host call stack) ·
`forbidden-import` · `internal-error`.

`errors[].kind`: `compile` (clang diagnostics of the **original** source) · `unsupported`
(`construct`, `line`; message `unsupported construct: X (line N)`) · `compile-timeout` ·
`instrumentation-failed` (valid C++ the instrumenter could not handle — an engine bug) · `link` ·
`forbidden-import` · `trace-corrupted` (`record`, `reason`) · `trace-truncated` · `internal-error`.

`vars`, `decls[fn]`, `globals` and `functions` are null-prototype objects (names such as
`__proto__` or `constructor` are plain own data).

### Stop semantics (what a step is)

The instrumenter inserts a probe wherever GDB with `g++ -O0` stops on `next`/`step`
(declarations with initialisers, expression statements, `break`/`continue`, every `for` entry and
increment, every `while`/`if` condition evaluation, `return` line and then the function's `}`,
falling off the end at `}`); range-for is expanded to the equivalent classic for. Consecutive
records with the same (line, function, activation) are merged, keeping the first (GDB only stops
when the line changes). Standard-library code is never stepped into. `depth` is the call depth
(main = 1), `frame` a unique id per function activation.

D6 (uninitialised variables): a variable declared without initialiser is reported as 0 (arrays keep
their shape) and listed in `uninit` until a statement that may write it has executed in that
activation (assignment target, `++/--`, `&x`, reference argument such as `cin >> x`, member access,
array decay). The rule is conservative: it may stop flagging early, never late.

### Supported / refused syntax

Supported: procedural code, recursion, reference parameters, range-for (incl. structured
bindings and braced lists), global variables, `long long`, structs without member functions
(value `"<?>"`), object-like macros anywhere, function-like macros as whole statements.

Refused with `unsupported construct: X (line N)`: `switch`, `do-while`, `goto`/labels, `try`/`throw`,
lambdas, templates, class member functions (use `instrument: false`), user namespaces, overloaded
functions, `if`/`while` with initialiser or condition variable, `if constexpr`, static locals,
GNU statement expressions, `asm`, attributed statements, coroutines, function-like macros inside
conditions / increments / return values (e.g. `#define rep(i,n) for(...)`), code or `#if` blocks
before the first declaration after the includes.

Compile support (also with `instrument: false`): `<bits/stdc++.h>`, `<bits/extc++.h>` (GCC pb_ds
headers + a thin libstdc++ compat layer in `include/`), and `include/vgcompat.h`, force-included
into every compile: `std::__gcd` overloads and `typedef long long __int64` (spec finding F8).
C++ exceptions are unavailable (`-fno-exceptions`; WASI has none).

## Architecture

```
page thread (index.js)          pipeline.worker.js                 exec.worker.js (fresh per run)
 fetch manifest (no-cache)       Driver (driver.js): clang/lld on   frozen WASI imports, caps,
 fetch assets {integrity} ──────► MEMFS; PCH (pch.js); AST          runs _start(), returns
 compile clang/lld Modules        (userast.js) -> instrument.js ──►  stdout/stderr/fd3 bytes
 stage watchdog, respawn   ◄──── compiled student Module
 spawn exec worker, wall clock ──────────────────────────────────► 
 decode request ─────────────────► trace.js (validate + decode)
```

- The page thread downloads and verifies the assets and hands compiled `WebAssembly.Module`s to the
  pipeline worker, so that worker needs no network access (`connect-src 'none'`) — plan §1.5(c).
- The page thread (not the pipeline worker) creates the execution worker, so neither worker needs
  to create nested workers (S2 negative test "nested `new Worker` blocked" stays possible).
- `exec.worker.js` has no imports at all.
- Deviation from the contract §3 layout: `vendor/` holds only the pinned browsercc emscripten glue
  (`clang.js`, `lld.js`, LICENSE, `SHA256SUMS`); the binaries live in the git-ignored `assets/`, and
  `@bjorn3/browser_wasi_shim` is not used at runtime (see Threat model) — it is kept pinned as the
  test oracle for the engine's own WASI implementation.

## Trace format and channel

Each probe writes one JSON line to **WASI fd 3** with a single `fd_write` (unbuffered, so a record
is never lost when the program traps or is killed):

```
{"p":17,"line":34,"fn":"main","depth":1,"frame":1,"n":["h","w","cost","i"],"d":{"i":2}}
{"limit":"steps"}            // written before exit(124) at 200000 records or 20 MB
```

`p` is the probe-site id. The instrumenter returns a static probe table (`meta.probes[p] =
{line, fn, names, u, w}`) that never passes through the student program; `n` lists the names in
scope and `d` only the values that changed since the last record of the same (function, name) (delta
encoding, ~10x smaller). `name.capacity()` pseudo-variables carry `std::vector` capacities.

Validation (`trace.js`, per line in try/catch): `p` must exist; `line` must be an integer in
`1..lineCount` **and** equal the site's line; `fn` must equal the site's function (so it is in the
instrumenter's function set); `n` must contain exactly the site's names (plus optional
`<name>.capacity()`), each once; `d` may only contain names from `n`; `depth`/`frame` positive
integers; no other fields; at most 200 100 records. The first bad record produces
`{kind:"trace-corrupted", record, reason}` and decoding stops there (the delta state cannot be
trusted after a dropped record); earlier steps are kept and `ok` is `false`. State lives in `Map`s
and null-prototype objects; function names go through `quote()` in `vg.h` and through a C++
string-literal escaper (`cStr`) in the instrumenter.

**Why fd 3 and why it is not forgeable by ordinary student code.** The student's normal output
paths — `cout`, `cerr`, `printf`, `puts`, `std::ofstream` — only reach fds 1/2 or fail (no
filesystem, `path_open` is ENOSYS), so printing a fake `\x01VG{…}` or JSON line to stdout/stderr
has no effect on the trace (the E2/E6 design parsed stderr, where this worked). fd 3 cannot be
closed or renumbered (`fd_close(3)` → EBADF, `fd_renumber` → ENOSYS). Writing to fd 3 requires
deliberately calling `write(3, …)` / `__wasi_fd_write(3, …)`, and such records must still match a
real probe site exactly. A dedicated custom import (`vg.emit`) was rejected because it would widen
the import allowlist beyond pure WASI and is just as reachable through `__attribute__((import_module))`.

**Residual risk (accepted, plan §6 M3):** a deliberately adversarial program can call
`__vg::step(...)` or write well-formed records to fd 3 and lie about its own state (e.g. report
wrong values at a real probe site). It cannot inject structure (validated schema), unknown lines,
functions or variable names, prototype keys, or unbounded data (caps). The trace is the program's
own claim about itself.

## Limits

| limit | value | where | why |
|---|---|---|---|
| linear memory | 512 MiB (`-Wl,--max-memory=536870912`) | linker | same budget as the server sandbox `ulimit -v 524288` |
| wasm shadow stack | 8 MiB, placed first (`-Wl,--stack-first -Wl,-z,stack-size=8388608`) | linker | 8 MiB = Linux default stack the GDB path gets (no `ulimit -s`); stack-first makes an overflow wrap below address 0 and trap instead of silently corrupting globals/heap |
| stdout / stderr | 1 MiB / 256 KiB | exec worker `fd_write` | checked before copying; the write that exceeds stores what fits and stops the program |
| trace (fd 3) | 24 MiB host cap; vg.h stops at 200 000 records or 20 MB | exec worker / vg.h | vg.h limit fires first with a clean `limit` record |
| execution wall clock | 5 s default, ≤ 30 s | page thread `terminate()` | server had 30 s CPU |
| compile budget | 8 s default, ≤ 9.5 s, AST+compile+link | page thread, terminate + respawn pipeline | error returned within 10 s (measured 8.03–8.04 s in tests) |
| PCH build | 30 s | page thread | depends only on the chosen system headers, not on student code |
| source / stdin | 256 KiB / 1 MiB | `normalizeRequest` | trust-boundary validation |
| clang stdout / stderr capture | 64 MiB / 1 MiB | driver.js | AST dump / diagnostics cannot exhaust the worker heap |

Measured recursion behaviour (Node worker threads, `depth(n)` = `1 + depth(n-1)`): the binding limit
is the **host's native call stack** (V8), not the 8 MiB shadow stack. With the default 4 MB Node
worker stack, plain code reached ≈47 000 frames and instrumented code ≈6 000–9 500 (JIT-tier
dependent; instrumented -O0 frames are bigger); with a 1 MB native stack ≈7 800 / ≈1 600. Depth
1e4: plain completes, instrumented ends with `stack-overflow`; depth 1e5: both `stack-overflow`
(clean, classified, trace kept). GDB expectation (Linux, 8 MiB stack, g++ -O0): both depths
complete; a local native g++ build with an 8 MiB stack also completes 1e4 and 1e5. **This is a known
difference, not parity**; browser worker stack sizes are not configurable and must be measured in S2.

## PCH cache (`pch.js`)

Key = sha256 of `[flags version, std, exact system #include list, sha256(vg.h), sha256(headers.tar),
sha256(clang.wasm), sha256(sysroot.tar)]` — hashes from the integrity-checked manifest, never
`Content-Length`. Stored in IndexedDB (`vgdb-pch-v2`: `meta` + `bytes` stores) with the sha256 of the
bytes; `get()` recomputes and drops mismatching entries; LRU with 6 entries / 120 MB defaults.
Programs whose prelude contains anything but `#include <…>` lines, blank lines and comments before
the last include (e.g. `#define` before an include) are compiled without PCH.

**`-fno-validate-pch` is removed.** Measured: with it, a PCH built for C++17 is silently accepted by a
C++20 compile and a modified `vg.h` goes unnoticed. The PCH is now built with `-fno-pch-timestamp`
and consumed with `-fpch-validate-input-files-content -Xclang -fmodules-validate-system-headers`, so
clang validates every input (including system headers) by content and rejects language-option
mismatches — defence in depth on top of the cache key and the sha256 read check.

`crypto.subtle` only exists in secure contexts; the production site is still plain HTTP (:5000), so
`sha256.js` falls back to a JS SHA-256 verified against `node:crypto`.

## Integrity and supply chain

- Exact pins (`package.json`) + `package-lock.json` with sha512 integrity; `npm ci`.
- `assets/manifest.json`: sha256 + SRI per asset. Browser: `fetch(url, {integrity})` for every asset,
  the manifest itself with `cache: "no-cache"`; any mismatch rejects (fail closed). Node harness:
  sha256 comparison before use.
- `vendor/browsercc/SHA256SUMS` pins the vendored glue; a test checks it equals the npm package.
- No COOP/COEP headers are required (no SharedArrayBuffer, no `measureUserAgentSpecificMemory`).

## Threat model

Assets: the student's page/session (same origin as the engine), the lesson data, other users.
Attacker: a student program (arbitrary C++), a tampered asset/cache, a malicious lesson file.
Trusted: the engine JS, the page, the manifest served with the page. Out of scope for S1 (S2):
per-file CSP headers, the opaque-origin iframe option, browser-specific worker behaviour.

| # | mechanism | threat | test |
|---|---|---|---|
| M1 | import allowlist: every import must be a `wasi_snapshot_preview1` function in the 46-name preview1 list, checked with `WebAssembly.Module.imports()` before instantiation | `__attribute__((import_module("env")))` reaching host JS | `security.test.mjs` "env.x is rejected"; `unit.test.mjs` "checkImports …" |
| M1 | frozen import object, only 16 functions implemented, all others `ENOSYS` | filesystem / socket access | `security.test.mjs` "path_open and sock_send return ENOSYS"; `unit.test.mjs` "every non-implemented function returns ENOSYS", "import object is frozen" |
| M1 | the engine's WASI matches the reference shim for console programs | WASI regressions | `wasi_oracle.test.mjs` |
| M2 | 512 MiB `--max-memory`, 8 MiB stack-first | memory exhaustion, silent stack corruption | `security.test.mjs` "linker caps linear memory", "vector<char>(3e9)", "new char[1<<30]" |
| M2 | stdout/stderr/trace byte caps inside `fd_write` | output flooding | `security.test.mjs` "infinite 1 MB print loop", "stderr is capped"; `unit.test.mjs` "fd_write enforces host-side caps" |
| M2 | wall-clock `terminate()`; vg.h step/byte limit | infinite loops | `timeouts.test.mjs` "for(;;){}", "while(true) x++" |
| M2 | compile budget + pipeline respawn | template/constexpr bombs | `timeouts.test.mjs` "compile bomb (instrument=true/false)" |
| M2 | recursion behaviour recorded | deep recursion | `security.test.mjs` "recursion depth 10000 / 100000" |
| M3 | dedicated fd-3 channel | fake trace lines in program output | `security.test.mjs` "fake \x01VG / JSON trace lines" |
| M3 | strict per-record validation, per-line try/catch | forged/garbage records | `security.test.mjs` "garbage written straight to fd 3", "unknown function forged on fd 3"; `unit.test.mjs` 17 corrupted-record cases |
| M3 | `quote()`/`cStr()` for function names | names with `"`/unicode breaking JSON or C++ | `security.test.mjs` "operator\"\"_km, unicode"; `instrument.test.mjs` "cStr escapes …" |
| M3 | Map / null-prototype objects, restored after structured clone; evalexpr own-property checks | `__proto__` pollution | `security.test.mjs` "__proto__ / constructor / toString"; `unit.test.mjs` "__proto__/constructor as variable names", "evalexpr: own-property lookups only" |
| L1 | PCH key from asset hashes, sha256 on read, LRU, content validation | poisoned / stale PCH cache | `unit.test.mjs` "pch: …"; `assets.test.mjs` "PCH IndexedDB adapter"; `pch_integration.test.mjs` |
| H2 | manifest sha256/SRI, exact pins, vendored glue sums | tampered assets | `assets.test.mjs` (pins, SHA256SUMS, manifest, one flipped byte fails closed, SRI options + fail closed) |
| — | trust-boundary validation of `runProgram` arguments | oversized / malformed requests | `timeouts.test.mjs` "execution timeout is clamped …" |
| 6 | explicit refusal of unsupported constructs | mis-instrumented traces | `instrument.test.mjs` (14 constructs) |

## Tests

```sh
node --test --test-concurrency=1 tests/engine      # from the repository root; ~3 min
```

`--test-concurrency=1` matters: every test file boots its own 42 MB wasm compiler, and with the
default (CPU count − 1) parallel files, CPU starvation makes legitimate compiles exceed the 8 s
wall-clock budget — the watchdog then (correctly) reports `compile-timeout`.

| file | covers |
|---|---|
| `unit.test.mjs` | trace decoder/validator, PCH cache, SHA-256, WASI object, evalexpr, manifest, jsonsplit, prelude scan |
| `security.test.mjs` | M1/M2/M3 negative tests (contract §5) |
| `timeouts.test.mjs` | compile bomb + respawn, `for(;;){}`, step limit, option clamping |
| `differential.test.mjs` | 5 programs vs the GDB references (3-state; `run_differential.mjs` prints the table) |
| `e3.test.mjs` | the 22 E3 cases: stdout == local g++ (`expected/e3/` fallback, generated by `gen_expected.mjs`) |
| `golden.test.mjs` | golden sample v0 stop kinds/lines vs the engine (`experiments/frontend-only/golden/golden_to_stops.mjs`) |
| `compile_support.test.mjs` | bits/stdc++.h, extc++.h/pb_ds, `std::__gcd`, `__int64`, CC-26xxB uninstrumented, diagnostics |
| `instrument.test.mjs` | refused constructs, supported syntax, `decls`, D6 |
| `pch_integration.test.mjs` | PCH validation decision, PCH reuse, identical output with/without PCH |
| `assets.test.mjs` | pins, vendored glue, manifest, fail-closed loaders, browser adapters with fakes, fake IndexedDB |
| `wasi_oracle.test.mjs` | engine WASI vs `@bjorn3/browser_wasi_shim` |

`tests/engine/node_driver.mjs` runs the same `index.js` + workers in Node (worker_threads with a
small `self`/`postMessage` shim); `node tests/engine/node_driver.mjs prog.cpp [input]` runs one program.

## Known gaps (S2+)

- Nothing here was run in a browser: worker CSP, `fetch` integrity behaviour, IndexedDB, module
  workers, and the native stack depth of browser workers are S2 items.
- Deep recursion is limited by the host's native stack well before GDB's 8 MiB (see Limits).
- Fixed wall-clock compile budget: a very slow machine's first (cold) compile could be reported as
  `compile-timeout`; measure on target laptops in S2.
- `@ts-check` annotations were not machine-checked: the repository's TypeScript 3.9 cannot parse the
  vendored emscripten glue.
- The PCH cache stores ~14–21 MB per include set in IndexedDB; a shared browser profile is out of
  scope (plan §6 L1).
- Values: stack/queue/priority_queue and structs are `"<?>"`; pointers are `"<ptr>"`; type-string
  generation from `decls` is S4.
