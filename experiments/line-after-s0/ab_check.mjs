// A/B check: run the localgdb fixture (SMALL_SRC) through the engine and print the run errors.
// Usage (inside the container, cwd = tree root): node experiments/line-after-s0/ab_check.mjs
import { loadNodeEngine } from "../../tests/engine/node_driver.mjs";

const SRC = "int main() {\n  int x = 1;\n  x = 2;\n  return 0;\n}\n";
const eng = await loadNodeEngine();
for (let i = 0; i < 2; i++) {
  const r = await eng.runProgram(SRC, "", {});
  console.log(`run ${i}: ok=${r.ok} exit=${JSON.stringify(r.exit)} errors=${JSON.stringify(r.errors)} steps=${r.steps.length}`);
}
eng.dispose();
