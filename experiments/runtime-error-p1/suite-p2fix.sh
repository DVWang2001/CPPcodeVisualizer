# P2 front-end fixtures (run_p1.sh run NAME suite-p2fix.sh): run the first-batch error programs through the P1 engine
# (runProgram, as production runs it) and build LocalGdb's TraceModel exactly as session.js does, then print what the
# runtime-error panel can read from it: runtimeErrors, exit, the model's steps (pointer targets already resolved),
# functions, decls, classes, stdout. One "P2FIX <json>" line per program. A run longer than 300 steps keeps its first
# 60 and last 60 steps (as [index, step] pairs). Fixtures for gdbgui/src/js/tests/runtimeDiag*.jest.ts come from here.
set -u
cat > /tmp/p2fix.mjs <<'EOF'
import fs from "node:fs";
import { pathToFileURL } from "node:url";
const nd = await import(pathToFileURL("/app/tests/engine/node_driver.mjs").href);
const { CASES } = await import(pathToFileURL("/app/tests/engine/runtime_errors/cases.mjs").href);
const { TraceModel } = await import(pathToFileURL("/app/gdbgui/static/engine/localgdb/model.js").href);
const pick = ["div0_input", "div0_const", "div0_unused", "mod0_loop", "intmin_div", "ovf_add", "ovf_fact", "ovf_loop",
  "arr_oob_write", "arr_oob_read", "arr2d_oob", "vec_oob", "vec_at", "vec_empty_back", "vec_pop_empty", "stack_empty_top",
  "queue_empty_front", "str_oob", "null_write", "null_read", "missing_return", "inf_recursion", "deep_recursion", "shift_big"];
const H = "#include <bits/stdc++.h>\nusing namespace std;\n";
const progs = pick.map((id) => { const c = CASES.find((x) => x.id === id); if (!c) throw new Error("no case " + id); return { id, src: c.src, stdin: c.stdin || "" }; });
for (const f of ["err_int_overflow", "err_array_oob", "err_null_deref"])
  progs.push({ id: "ex_" + f, src: fs.readFileSync("/app/examples/cpp/errors/" + f + ".cpp", "utf8"), stdin: "" });
const extra = {
  rec_cond: H + "int f(int n) {\n  if (n == 0) return 0;\n  return f(n - 2) + 1;\n}\nint main() {\n  cout << f(3) << endl;\n  return 0;\n}\n",
  arr_local: H + "int main() {\n  int a[3] = {1, 2, 3};\n  int x = 5;\n  for (int i = 0; i <= 3; i++) a[i] = 0;\n  cout << x << endl;\n  return 0;\n}\n",
  div_expr: H + "int main() {\n  int a = 7, b = 3;\n  int c = a / (b - 3);\n  cout << c << endl;\n  return 0;\n}\n",
  null_heap: H + "struct Node {\n  int val;\n  Node* next;\n};\nint main() {\n  Node* head = new Node{1, nullptr};\n  head->next = new Node{2, nullptr};\n  Node* p = head;\n  while (p != nullptr) {\n    p = p->next;\n  }\n  cout << p->val << endl;\n  return 0;\n}\n",
  pq_empty_top: H + "int main() {\n  priority_queue<int> pq;\n  pq.push(3);\n  pq.pop();\n  cout << pq.top() << endl;\n  return 0;\n}\n",
  stack_pop_empty: H + "int main() {\n  stack<int> s;\n  s.pop();\n  cout << s.size() << endl;\n  return 0;\n}\n",
  ovf_fn: H + "int twice(int x) {\n  return x * 2;\n}\nint main() {\n  int big = 1500000000;\n  cout << twice(big) << endl;\n  return 0;\n}\n",
};
for (const [id, src] of Object.entries(extra)) progs.push({ id, src, stdin: "" });
const eng = await nd.loadNodeEngine();
for (const p of progs) {
  const r = await eng.runProgram(p.src, p.stdin);
  let model = null, merr = null;
  try { model = new TraceModel({ ...r, source: p.src }); } catch (e) { merr = String(e && e.message || e); }
  const steps = model ? model.steps : (r.steps || []);
  const n = steps.length;
  const idx = n <= 300 ? steps.map((_, i) => i) : [...Array(60).keys(), ...Array.from({ length: 60 }, (_, k) => n - 60 + k)];
  console.log("P2FIX " + JSON.stringify({
    id: p.id, src: p.src, stdin: p.stdin, ok: r.ok, errors: r.errors, modelError: merr,
    exit: model ? model.exit : r.exit, runtimeErrors: model ? model.runtimeErrors : r.runtimeErrors,
    stdout: typeof r.stdout === "string" ? r.stdout.slice(0, 2000) : r.stdout,
    functions: r.functions, decls: r.decls, classes: r.classes, globals: r.globals,
    nSteps: n, steps: idx.map((i) => [i, steps[i]]),
  }));
}
eng.dispose();
console.log("P2FIXDONE " + progs.length);
EOF
cd /app/gdbgui/static/engine && node scripts/build-assets.mjs > /tmp/assets.txt 2>&1 || { cat /tmp/assets.txt; echo "BUILD-ASSETS FAILED"; exit 1; }
cd /app && node /tmp/p2fix.mjs
