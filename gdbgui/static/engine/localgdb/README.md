# LocalGdb: a GDB/MI emulation driven by the in-browser engine (M1, layer A)

Pure JS (ES modules, JSDoc, no bundler, no DOM/Node APIs; runs in Node and in a page). Given the result of
`engine.runProgram(source, stdin)` (steps, decls, functions, globals, stdout, exit) it answers the GDB/MI
conversation the gdbgui UI holds over socket.io (`/gdb_listener`, spec §1/§2/§5/§12): same packet shapes,
same item order, same stop semantics as the recorded golden sample of a real GDB 16.3. Nothing is executed
here: the program already ran (S1 engine); LocalGdb replays that recording.

Contract: `docs/superpowers/plans/2026-09-26-S3S4-M1-contract.md` §2 layer A / §4-A.
Tests: `tests/engine/localgdb/` (see "Tests" below). Layer B (UI wiring) is **not** part of this package.

## Files

| file | role |
|---|---|
| `index.js` | `createLocalGdb(opts)` -> `{ socket, session, connect(), idle(), setRunToken(t), stdinReceived, close() }` |
| `socket.js` | `LocalSocket`: the socket.io-client subset the UI uses |
| `session.js` | command dispatch, item construction for every supported command, fast-forward simulation |
| `exec.js` | breakpoint table + execution control (continue/next/step/finish/reverse) over the trace |
| `model.js` | frame structure of the trace, visible variables per step (GDB block rules), signatures, pseudo addresses |
| `scopes.js` | lexical blocks of each function recovered from the SOURCE text (see "Scope analysis") |
| `varobj.js` | variable objects (`-var-*`, S4 minimal set, expressions, `&(name)` pointers) |
| `expr.js` | typed C++ expression evaluator (arithmetic, comparisons, subscripts) |
| `types.js` | clang `qualType` -> libstdc++/GDB type spelling, classification, GDB value formatting |
| `fastforward.js` | parser of the `python exec("...")` fast-forward command + Python-compatible JSON writer |
| `mi.js` | command-line parsing and the MI item constructors |

## API

```js
import { loadEngine } from "../index.js";
import { createLocalGdb } from "./index.js";

const engine = await loadEngine();
const runResult = await engine.runProgram(source, stdin);          // must have ok === true
const gdb = createLocalGdb({
  source,                       // the C++ text that was run (block/scope structure is derived from it)
  stdin,                        // informational (pty `write` is only acknowledged, see below)
  runResult,
  sourcePath: "/workspace/main.cpp",   // -> `fullname` everywhere (display path; spec §12 N1)
  gdbFilePath: "/srv/x/main.cpp",      // -> `file` everywhere (pseudo real path; spec §12 N1)
  pid: 4242,                    // pseudo pid (default 4242)
  now: undefined,               // reserved: no packet field carries a timestamp
  recordSubcommands: false,     // test aid: keep `session.subcommandLog` (one entry per MI/CLI command)
  autoConnect: true,            // emit connect + debug_session_connection_event on the next microtask
});
const socket = gdb.socket;      // hand this to the UI instead of io.connect(...)
```

`createLocalGdb` throws when `runResult` is missing or `runResult.ok === false` (compile errors take the
simulated `/create_and_upload` error path in layer B, not this package). A non-instrumented run
(`steps: []`) is fine: `-exec-run` just runs to the end, delivers the output and reports `exited-normally`.

### Socket surface (what the UI touches)

`LocalSocket` implements: `on(event, cb)`, `once`, `off`, `emit(event, payload)`, `connected`, `disconnected`,
`close()` (+ `disconnect()`, `removeListener`, `removeAllListeners`). Delivery is asynchronous (microtask),
so handlers registered right after creation see `connect`.

| direction | event | payload |
|---|---|---|
| server -> client | `connect` | none (first) |
| server -> client | `debug_session_connection_event` | `{ok:true, started_new_gdb_process:true, message:"Started new gdb process, pid N", pid}` |
| client -> server | `run_gdb_command` | `{cmd: string[] (or string), run_token, request_id}`; processed strictly FIFO; a non-null `run_token` that differs from `setRunToken(t)` is dropped silently (spec §4) |
| server -> client | `gdb_response` | `{run_token, request_id, packet_seq_num, data:[items]}`; one packet per `run_gdb_command`; `packet_seq_num` starts at 1 and strictly increases; `request_id` is the session-level last received request id (spec §12 N4); `run_token` echoes the command's |
| client -> server | `pty_interaction` | `{data:{pty_name, action, key?}}`: program_pty `flush`/`write` are acknowledged (`gdb.stdinReceived`), `set_winsize` ignored, user_pty `write` answers with `user_pty_response` "not supported" |
| server -> client | `program_pty_response` | the program's stdout (+stderr) with LF -> CRLF, delivered **once, when the program ends, right after the gdb_response that carries the exit** (golden order) |
| server -> client | `error_running_gdb_command` | `{message}` for malformed payloads (`cmd` not string/array of strings, no `data` in pty_interaction) |
| server -> client | `user_pty_response` | only the "not supported" text above (GDB's console mirror is not emulated) |

Item shapes (spec §12 A6, golden): `result` items carry `token` (the numeric prefix of the command, else `null`);
`notify` items carry `token: null`; `output`/`console`/`log` items have **no** `token` key; every item has
`stream: "stdout"`. A bare `^done` / `^running` reaches the UI as `{type:"output", payload:"^done\r"}` exactly like
the golden sample (a numeric token stays in the raw text: `"4^done\r"`).

`await gdb.idle()` resolves when every queued command has been answered (tests use it to "wait like the UI").

## Command matrix

| command | status | notes |
|---|---|---|
| `-list-features`, `-list-target-features` | supported | features = golden GDB 16.3 list + `"reverse"` (spec §12 N3) |
| `-gdb-set`, `-file-exec-and-symbols`, `-exec-arguments`, `-environment-cd`, `-enable-pretty-printing` | accepted (bare `^done`) | no effect |
| `-interpreter-exec console "delete" / "unset substitute-path" / "set substitute-path A B"` | supported | `delete` clears the table (numbering continues); `unset substitute-path` prints GDB's console line; other CLI: explicit error |
| `-break-insert` (`-t -f -d -h -c COND -i N`, `file:LINE`, `LINE`, `func`, `file:func`) | supported | line without code moves to the next line with code; `-f` makes unknown locations pending (`addr:"<PENDING>"`); `*ADDR` -> explicit error; `bkpt.func` is the demangled signature (`fact(int)`, `fill(std::vector<int, std::allocator<int> >&, int)`) |
| `-break-list`, `-break-delete`, `-break-enable`, `-break-disable`, `-break-condition` | supported | `-exec-run` resets hit counts (`times`) like GDB; notifications `breakpoint-deleted` / `breakpoint-modified` precede the `^done`; hit counts (`times`) per hit; ignore counts; temp breakpoints deleted after the stop |
| `-exec-run`, `-exec-continue`, `-exec-next`, `-exec-step`, `-exec-finish` (+ `--reverse`) | supported | stop reasons `breakpoint-hit`, `end-stepping-range`, `function-finished`, `exited-normally` (+ `exited`, `signal-received`, `exited-signalled`, `no-history`); see "Stepping semantics" |
| `-exec-interrupt` | always `^error` "Current thread is not running." | execution is instantaneous (recorded); the UI's abort goes through `/send_signal` (layer B) |
| `-exec-next-instruction`, `-exec-step-instruction`, `-exec-until`, `-exec-return`, `-exec-jump` | explicit error `... is not supported by the browser engine` | |
| `-thread-info`, `-thread-select 1` | supported | |
| `-stack-list-frames [lo hi]`, `-stack-list-arguments N [lo hi]`, `-stack-list-variables [--simple-values\|--all-values\|--no-values]`, `-stack-select-frame N`, `-stack-info-depth` | supported | variables in GDB order: innermost block first, all block variables (also ones declared later), shadowed variables both listed; `--simple-values` gives a value only for int/bool/char/float/pointer (and refs to those), not for vectors/strings/arrays/structs |
| `-var-create`, `-var-update`, `-var-list-children`, `-var-delete [-c]`, `-var-evaluate-expression`, `-var-info-type`, `-data-evaluate-expression` | supported for the S4 set + arithmetic expressions + `&(name)` | see "Variable objects" |
| `python exec("...@@FF@@...")` | supported | only the `[fast @N]` jump script of `fastForwardJump.ts`; any other `python` -> explicit error |
| `-data-list-register-*`, `-data-read-memory*`, `-data-disassemble`, `-target-*`, `-break-watch`, `-catch-*`, `-var-assign`, `-var-set-*` ... | explicit error `... is not supported by the browser engine` | never fake data |
| unknown MI command | `^error,msg="Undefined MI command: NAME",code="undefined-command"` | |
| `kill` (also `-interpreter-exec console "kill"`) | supported | live inferior: console `[Inferior 1 (process N) killed]`, `=thread-exited`, `=thread-group-exited`, `^done`; afterwards the "no process" state (`-exec-*` -> `The program is not being run.`, `-thread-info` -> `{threads:[]}`) and `-exec-run` starts again. No process: `The program is not being run.` (GDB's own text). Not in the golden sample; shape from GDB knowledge |
| other CLI commands (`backtrace`, ...) | explicit error | |

Before `-exec-run` / after the program ended: exec commands -> `The program is not being run.`;
`-thread-info` -> `{threads:[]}`; `-stack-list-frames` -> `No stack.`; `-stack-list-variables` ->
`No frame selected.`; `-var-update` -> out-of-scope entries.

## Stepping semantics (decided from the trace)

The trace is a list of GDB-style stops (`line`, `fn`, `depth`, `frame`, `vars`). A position is a step index.

- `continue` / run: next step (after the position) on a line with an enabled breakpoint whose condition is true and
  whose ignore count is spent; otherwise the program ends.
- `next`: next step with `depth <=` current depth; deeper steps are stepped over unless a breakpoint hits inside.
- `step`: the very next step (the engine never enters the standard library).
- `finish`: runs until the SELECTED frame returns (breakpoints inside are honoured) and lands on the **caller's
  call line** (mid-statement, `function-finished`, no `return-value`). In `main`: `"finish" not meaningful in the outermost frame.`
- Returning from a function with `next`/`step` finishes the caller's statement and stops on the NEXT line (no extra stop on the
  call line; verified against GDB 16.3 reference runs). Only `finish` stops mid-line on the call.
- `next`/`step` stop when the LINE changes: a later step of the same frame on the same line as the origin (the then-branch of
  `if (f(x)) cout << ...;` after the callee ran) is not a new stop, nor is the rest of the caller's call line after returning from a
  callee. A `for` increment stop after the body is a different line visit and stays (`lines.test.mjs`).
- A breakpoint on a loop-header line (`for`, `while`) hits at loop ENTRY only, not at every increment/condition re-evaluation (GDB places
  it on the entry code; the lesson bundles' recorded hit counts confirm it: a breakpoint on a `while` line has `times` = number of loop
  entries). This replaces the earlier documented "stops on every visit" gap.
- A stepping command that ends on a line with an enabled breakpoint reports `breakpoint-hit` (GDB does the same).
- Reverse (`--reverse`): the same rules walking the trace backwards (`step` back into a callee's last step, `next` steps back
  over calls, `finish` back to the call site, `continue` to the previous breakpoint). The trace start reports
  `stopped reason="no-history"` with GDB's console text.
- Past the end of `main`, `next`/`step` end the program (real GDB would stop in `__libc_start_call_main` first).
- A run that ended abnormally (`exit.reason` != `exit`, e.g. a trap) stops once with `signal-received`
  (SIGSEGV/SIGABRT/SIGFPE/SIGXCPU/SIGKILL from the trap kind) at the last recorded step, then `exited-signalled`; a non-zero
  exit code gives `reason:"exited", exit-code:"03"` (octal like GDB).

## Fast-forward (`[fast @N]`, D11)

The command `python exec("...")` built by `gdbgui/src/js/fastForwardJump.ts` is recognised by its marker `@@FF@@`; the
limit, target line and remaining visits are read out of the literal script text with tolerant regexes
(`fastforward.js`). The script's loop is simulated on the trace (`next` until the target line has been visited N times, or
the limit, or the program ends) and answered in the golden order: the `log` echo of the command, `^running` once, per internal
`next` `running` / console `LINE\tin FILE` / `stopped`, then the console line
`@@FF@@{"stacks": [...], "counts": {...}, "landed": bool, "steps": n}@@/FF@@` written like Python's `json.dumps`
(separators, key order incl. integer-like `counts` keys). Frame dicts are `{func, addr, line, fullname, args}`; like
`gdb.Frame.block()` iteration, `args` is only filled while the frame's pc is in the function's own block (not inside a
nested `for`/`{}` block). If the program ends first: `landed:false`, exit items, output delivered.
`tests/engine/localgdb/fastforward_template.test.mjs` reads the TypeScript template as text and fails loudly when a
placeholder or the shape the parser relies on changes.

## Variable objects (S4 minimal set)

Supported:
- a **plain variable name** (local or global) of int-family / bool / char / float / double / `std::string`, `std::vector<T>` (T supported,
  nested vectors of any depth), a **C array** of a supported element type (1-D and multi-dimensional, e.g. `int cand[3]`, `int memo[4][5][4]`,
  `char s[10]`, `std::string names[2]`, `std::vector<int> vs[2]`), or a reference to those;
- **arithmetic / subscript expressions** (`w - 1`, `j + 1`, `dp[r][j + 1]`, `x > 3 && !done`, `-x`, `c ? a : b`, integer/floating literals,
  `true`/`false`) evaluated by `expr.js` with C++ rules: integer promotion and usual arithmetic conversions, 32-bit wrap for `int`
  (64-bit for `long`/`long long`), truncating `/` and `%`, `Division by zero` (GDB's text), comparisons/logical operators give `bool`
  (printed `true`/`false`), any double operand gives `double`, `[]` on vectors/strings/nested vectors/C arrays (`cand[i + 1]`, `m[1][2]`).
  Literals: decimal, octal (`010` = 8), hex (`0x10`), `true`/`false`, floating (`1.5`, `1.5f`), integer suffixes `U`, `L`, `LL`, `UL`, `ULL`
  with the C++ literal type rules (`2LL * big` is `long long`, `1U - 2` is `unsigned int` 4294967295, `2147483648` is `long`, `0xffffffff`
  is `unsigned int`); invalid literals give `Invalid number "08".` / `Numeric constant too large.` Expressions over 4096 characters,
  512 tokens or 64 nesting levels (or exhausting the host stack) give the explicit error
  `expression too long or nested too deeply: not supported by the browser engine`. The result must be a scalar
  (a container-valued expression such as `g[0]` is an explicit error). The varobj's block is the innermost block of the variables it uses
  (so it goes out of scope like GDB's); an expression without variables has no `thread-id`. Not supported: unary `*`, `->`, `::`, bitwise
  and shift operators, casts, calls. `evalexpr.js` (the engine's untyped evaluator) was not reusable for this: it cannot type results
  (`int` vs `bool`), wrap 32-bit ints or give GDB's messages; `tests/engine/localgdb/expr.test.mjs` cross-checks the two on the grammar they share.
  Member calls (`v.size()`, `v.empty()`, `v.capacity()`) stay `Cannot evaluate function -- may be inlined`, which is what real GDB answers for
  libstdc++ members (golden: `cost.capacity()`), even though evalexpr.js would compute them;
- **`&(name)` / `&name`** for variables of scalar type, supported vectors or supported C arrays (`int (*)[3]`, child `*&(cand)` = the array varobj `[3]`): a pointer varobj shaped like the golden's: `numchild:"1"`,
  type `T *`, value a stable pseudo address (`0x7ffe...`, equal on every read), `has_more:"0"`; its one child is `NAME.*&(name)`
  (`exp:"*&(name)"`, the pointee's value/type) or, for vectors, `NAME.std::_Vector_base<E, std::allocator<E> >` (`value:"{...}"`, `numchild:"1"`;
  expanding that class is an explicit error). Pointer children follow the variable in `-var-update`; the pointer itself never changes.

- names `var1`, `var2`, ... in creation order; the counter also advances when a create fails (GDB does the same; the golden
  sample skips `var3` after a failed `cost.capacity()`);
- type strings are libstdc++-style: `std::vector<std::vector<int>>` ->
  `std::vector<std::vector<int, std::allocator<int> >, std::allocator<std::vector<int, std::allocator<int> > > >`;
  `std::string` at top level, the full `std::__cxx11::basic_string<...>` inside template arguments; `int [3]`, `int [2][3]`, `int *`,
  `int (*)[3]`, `T &`;
- value strings: `std::vector of length N, capacity M` (top level: the engine's capacity probe; inner vectors: capacity = length),
  `"text"`, `true`/`false`, `97 'a'`, doubles with 17 significant digits like GDB (`0.10000000000000001`), references `@0xADDR: value`;
- **C arrays** are plain (not dynamic) varobjs like GDB's: value `[N]`, `numchild:"N"` at creation, no `displayhint`/`dynamic`,
  `has_more:"0"`; children `NAME.i` with `exp:"i"` (element type/value; a row of a multi-dimensional array is again `[N]` with N
  children); the `-var-list-children` result has no `displayhint`. The element type keeps the declared spelling (`std::string`, not the
  `basic_string<...>` expansion used for vector children). Element changes reach `-var-update` through the listed children (the
  array varobj's own value `[N]` never changes). `-stack-list-variables --simple-values` lists arrays without a value (golden: `cand`);
- **print format** (`-stack-list-variables --all-values`, `-data-evaluate-expression`, frame args of `[fast @N]` blobs) follows GDB's
  `print` with the defaults `set print elements 200` and `set print repeats 10`: arrays `{5, 60, 7}`, `{{1, 2, 3}, {4, 5, 6}}`, runs of
  MORE than 10 equal elements collapse to `0 <repeats 14 times>` (GDB's `reps > repeat_count_threshold`), at most 200 elements then
  `...` (`{0, 1, ..., 199...}`), char arrays as strings (`"ab\000\000..."`; the final NUL of an untruncated char array is not
  printed; runs of more than 10 equal chars as `'\000' <repeats 18 times>`; the same repeat rule applies to `std::string` values),
  vectors through the libstdc++ printer including their elements (`std::vector of length 3, capacity 4 = {0, 1, 4}`; the printer's
  children are not repeat-compressed). A varobj's own `value` stays the short form (`std::vector of length 3, capacity 4`, `[3]`);
- vectors are dynamic varobjs: `displayhint:"array"`, `dynamic:"1"`, `has_more:"1"` at creation, `numchild:"0"` until the children were
  listed; children `NAME.[i]` (`exp:"[i]"`), `--all-values` / `--simple-values` / `--no-values`, optional `FROM TO` range;
- `std::deque<T>`, `std::list<T>`, `std::stack<T>`, `std::queue<T>` (T supported) are also dynamic varobjs, flat `NAME.[i]` children
  like vector's, `has_more` reflecting emptiness (unlike vector's always-`"1"`). Value/type text follows GDB's libstdc++ printers
  exactly, which are *not* uniform across these four: deque/stack/queue show `std::deque with N elements` / `std::stack wrapping:
  std::deque with N elements` / `std::queue wrapping: std::deque with N elements` (`"1 element"` singular), `displayhint:"array"`,
  print format with no per-child index (`{1, 2, 3}`); list has **no displayhint at all**, its type is tagged `std::__cxx11::list<...>`
  (like `basic_string`'s tag), its value never counts elements — `std::__cxx11::list` / `empty std::__cxx11::list` — and its print
  format DOES label each child (`{[0] = 4, [1] = 5, [2] = 6}`). `std::map`/`set`/`priority_queue`/`unordered_*` remain unsupported
  (unordered_* would need libstdc++'s internal hash-bucket iteration order to match GDB, not attempted);
- `-var-update`: roots **newest first**, children depth-first; reports value changes; `in_scope:"false"` (no value) once when the
  varobj's frame returned or its block was left; the value again when the block is re-entered; a grown/shrunk vector adds
  `new_num_children`;
- `-var-delete` returns `ndeleted` = the varobj plus its instantiated descendants (`-c`: children only).

Explicit MI errors (never fake data), all `type:"result", message:"error", payload:{msg}`:

| case | msg |
|---|---|
| unsupported type (map/set/priority_queue/unordered_*, pointer, struct, arrays of those, `vector<bool>`, `vector<unsupported>`; also `&(name)` of those) | `type 'TYPE' is not supported by the browser engine` |
| syntax error | ``A syntax error in expression, near `REST'.`` |
| unsupported operator/construct (`*p`, `f(x)`, `a->b`, array-to-pointer decay such as `cand + 1`, container- or row-valued expression such as `g[0]` / `m[1]`, `&(map)`) | `... is not supported by the browser engine` |
| `x / 0`, `x % 0` | `Division by zero` |
| subscript out of range | `Cannot access memory at address 0x0` (GDB would read garbage) |
| `name.method(...)` (e.g. `cost.capacity()`, the UI's probe) | `Cannot evaluate function -- may be inlined` (GDB's own text; golden) |
| unknown name | `No symbol "NAME" in current context.` |
| unknown varobj | `Variable object not found` |
| no program / no frame | `No frame selected.` |

## Pseudo addresses (what the UI derives behaviour from)

`frame.addr` / `bkpt.addr` are not compared against GDB (allow rule `addr`), but the UI uses their ORDER and EQUALITY:
- `forHeader.ts` `decideForSegment` (called from `Actions.ts` `recompute_for_sub_step`): on a stop at a `for` line, segment "A" (init) iff
  `addr` equals the smallest addr seen so far for that line, else "C" (increment). Needs init addr < increment addr, both fixed per for-line.
- `callTree.ts` `ingestStack`: a caller frame's `addr` is the call-site identity (`normalizeAddr`): stable per call site, different for two
  calls on the same line. The FF blob's short hex (`0x4014ec`) is normalised by the UI.
- `Threads.tsx`: `frame.addr` equality selects the current frame. (`Breakpoints.tsx` only tests `addr === "(MULTIPLE)"`; the
  disassembly/memory panels are hidden.)

Layout (golden: line 33 has 0x40147d init < 0x401486 body < 0x4014ec increment; line 41 likewise): `lineAddr = 0x401000 + fnIndex*0x100000 +
line*0x100` (monotonic in source order, functions in declaration order, format `0x` + 16 hex digits); the stop after the body of a `for`
line (previous stop of the frame inside the loop) has the increment address `lineAddr(loop end line) + 0xC0 - nesting*0x10` (above the whole
body, inner loops below outer); breakpoint addr = `lineAddr` (the init address); the return address of a call made at step c is
`stepAddr(c) + 5 + 8*k` with k = index of the call among the calls made from that step (stable across iterations, distinct for `f(g(x))`);
frame 0 after `finish` reports the return address. Derived host-side from the trace order and the scope analysis; no engine change.
`tests/engine/localgdb/addresses.test.mjs` runs the UI's `decideForSegment` (literal copy) over the golden stops and ours and requires the
same A/C classification for every tsp `for` stop.

## Scope analysis (why `scopes.js` exists)

GDB lists locals per DWARF lexical block. The engine result has names per step but no block structure, so `scopes.js`
recovers it from the source text (token scan, not a C++ parser): function block (parameters + top-level locals), one block per
`for` statement (the init variables; range from the `for` line to the end of the loop), one per `{...}` body (lines strictly
inside the braces). This reproduces GDB's variable order at every line of the golden lesson (unit test `types_scopes.test.mjs`).
Heuristic limits: a declaration is `<type> name` followed by `= ; , ( { [ :` with `name` a known variable of the function;
macro-generated declarations fall back to the function block; two variables with the same name in different blocks share
the engine's name-keyed value (the innermost already-declared one gets it, the other shows the zero value).
**Recommended engine addition** (not done, engine files are frozen for this task): emit real block ranges and per-variable
declaration lines from the instrumenter's AST.

## Differences to real GDB (the closed allow list of the replay)

The replay (`tests/engine/localgdb/replay.test.mjs`) compares every sub-command of the golden run item by item. **Zero
differences outside this list** (rule name = key in `ALLOW_RULES` of `golden_replay.mjs`, with the count of uses in the replay):

| rule | what | uses |
|---|---|---|
| `addr` | address values, compared strictly: the WHOLE value is a hex address on both sides and either both or neither are null (`0x0` never matches a real address) (`addr`, hex pointer values, FF blob `addr`), or `@0xADDR: rest` with `rest` equal | 295 |
| `file` | `file` real path | 0 (the test passes the golden's real path as `gdbFilePath`) |
| `pid-thread` | pid (digits on both sides), thread `target-id`/`name`, `process N` in console text | 66 |
| `uninit-value` | value of a variable that is not initialised yet: ours is the zero of its type (D6), GDB's is stack garbage. Resolved per listed ENTRY, never by name (`variables[k]` -> the k-th entry; a `-var-create` of a name -> its innermost entry), so an initialised inner `r` is not excused by an uninitialised outer `r`. Required together: our value is zero, the golden value is a plain integer, LocalGdb flags that entry AND the ENGINE trace agrees (the entry receives the trace value and the engine lists it in `uninit`, or it receives none because its declaration is on the current or a later line). The (line, variable@declLine) pairs are recorded (45 in the replay); type/structure differences are never excused | 73 |
| `gdb-noise` | GDB startup/environment notifications: `library-loaded`, `thread-group-added`, `cmd-param-changed`, the ASLR warning `log` | 10 |
| `reverse-feature` | our extra `"reverse"` entry in `-list-features` (spec §12 N3) | 1 |
| `std-window-shift` | (b) consequence: after the golden's one `step` into `std::vector::operator[]` the first refresh reports changes our engine (which never enters the library) already reported one refresh earlier; compared as a merged, order-insensitive set | 1 |

Packet boundaries and `packet_seq_num` start are not compared (per-command flattened item sequences are). Not compared at all:
`user_pty_response` (GDB console mirror), timestamps (none exist in the items).

Also compared now: the packet `run_token` echo (null before `setRunToken`, the token afterwards, on the golden's packets and on ours).

Reported as **NOT TESTED** by the replay (never silently skipped; 6 of 554 golden sub-commands; the other 548 are compared, plus the program-output check):

| count | reason |
|---|---|
| 1 | GDB noise stop: `-exec-step` into `std::vector::operator[]` (libstdc++ frame; allowed difference (b)) |
| 5 | thread-info / stack-list-* / var-update while the golden is inside that libstdc++ frame |

All 75 golden `-var-create` (plain names, `&(x)` pointers, `w - 1` / `j + 1`, `x.capacity()` errors), 112 `-var-list-children` and 48 `-var-delete`
(including the pointer varobjs and their `_Vector_base` / `*&(x)` children) are compared.

Other known differences (outside the golden sample, documented, tested against our own expectations only):
finish has no `return-value`; C arrays: array-to-pointer decay, sub-array expressions (`m[1]`) and pointer arithmetic are explicit errors, elements of vector type inside an array use capacity = length, char-array printing follows GDB's rules as documented above (not recorded in a golden); `using namespace std;` programs work (unqualified `vector<int>` is normalised to `std::vector<...>`) but a structured-binding `auto` variable has no usable type (`?`, not supported); inner vector capacity = length; bp locations on several addresses are not modelled; `frame.addr`/pointer values
are deterministic pseudo values (equal for equal call sites); reference varobj value format (`@0xADDR: ...`) and the
update-record shape for growing vectors are from GDB knowledge, not from a golden.

## Tests

```sh
node --test --test-concurrency=1 tests/engine/localgdb      # from the repository root, ~12 s
```

| file | covers |
|---|---|
| `replay.test.mjs` | contract §4-A: the golden `run_gdb_command` sequence replayed in order against a real engine run of `tsp_uva116.cpp`; 27 deliberately altered goldens must fail |
| `compare.test.mjs` | the comparator and the golden segmentation (what the allow list lets through and what it must not) |
| `commands.test.mjs` | every supported command and error path on a real engine run of `programs/types_recursion.cpp` (recursion, ref params, nested vectors, string/double/bool/char/long long, unsupported types) |
| `protocol.test.mjs` | handshake, socket surface, FIFO, packet fields, tokens, run_token, pty, exit/signal paths, error payloads (hand-made trace, no compiler) |
| `fastforward_template.test.mjs` | D11 lock on `fastForwardJump.ts` |
| `types_scopes.test.mjs` | type expansion (incl. `using namespace std`), value formatting, block analysis |
| `arrays.test.mjs` | C arrays on a real engine run of `programs/arrays.cpp`: listing, varobjs, children, updates, expressions, `&(array)`, print format |
| `lines.test.mjs` | next/step line-change rule (same-line second probe), reverse, loop-header breakpoints |
| `lessons_corpus.test.mjs` | the real lesson bundles driven like the UI (breakpoints, run, continue, 30 next) vs the recorded GDB and wasm line sequences (evidence/m1_lessons_manual_lines.json) |
| `expr.test.mjs` | typed expression evaluator: C++ typing, wrap-around, GDB error texts, agreement with evalexpr.js |
| `golden_replay.mjs`, `helpers.mjs`, `ff_template.mjs` | shared library code (not tests) |

Each test file that runs the engine boots the 42 MB compiler once, hence `--test-concurrency=1`.

## For layer B (UI wiring)

- The UI-side stdin arrives through `pty_interaction` **after** the program was started, but the engine needs stdin when it
  runs the program, i.e. inside the simulated `/create_and_upload`. Layer B must take the same text from
  `_pending_input_injection` / the input box at Run time and pass it to `runProgram`; LocalGdb only acknowledges the later write.
- `createLocalGdb({ sourcePath: <create_and_upload.source_path>, gdbFilePath: <gdb_source_path> })`; call `setRunToken(<run_token>)`
  after the simulated `/create_and_upload` answered, so stale commands are dropped.
- The UI must use `socket.connected` / `socket.disconnected` / `close()` (all present); it never needs `socket.io`.
- Cold `runProgram` takes several seconds (compile); the UI's 10 s watchdog only starts after the first command, so run the engine
  before creating the session.
- No network, no CSRF token, no storage is used here.
- `-var-create` for `&(x)` and integer expressions (`w - 1`, `j + 1`, `dp[r][j + 1]`, which VisualizerHelper.js creates for guide tokens) is supported and
  answered like the golden.
