import {
  buildJumpCommand,
  extractJumpBlob,
  applyJumpBlob,
  FF_BEGIN,
  FF_END,
} from "../fastForwardJump";
import { global_variable } from "../global_variable";

describe("buildJumpCommand", () => {
  test("組出單行命令：前端只能送單行，不能有裸換行", () => {
    const cmd = buildJumpCommand(7, 13);
    expect(cmd.startsWith('python exec("')).toBe(true);
    expect(cmd.endsWith('")')).toBe(true);
    expect(cmd.includes("\n")).toBe(false);
  });

  test("內層腳本不含雙引號——有的話會把外層字串截斷", () => {
    // 去掉頭尾的 python exec(" 與 ")，中間不該再出現未跳脫的雙引號
    const cmd = buildJumpCommand(7, 13);
    const body = cmd.slice('python exec("'.length, -2);
    expect(body.includes('"')).toBe(false);
  });

  test("行號、剩餘次數、上限都代進去了", () => {
    const cmd = buildJumpCommand(42, 5, 99);
    expect(cmd).toContain("_ln==42");
    expect(cmd).toContain(">=5");
    expect(cmd).toContain("_i<99");
  });
});

describe("extractJumpBlob", () => {
  const blob = { stacks: [[{ func: "f", line: 7 }]], counts: { "7": 1 }, landed: true, steps: 1 };

  test("從混雜的 console 輸出裡切出 blob", () => {
    const text = `some noise${FF_BEGIN}${JSON.stringify(blob)}${FF_END}trailing`;
    const got = extractJumpBlob(text);
    expect(got).not.toBeNull();
    expect(got!.landed).toBe(true);
    expect(got!.stacks).toHaveLength(1);
  });

  test("沒有標記回 null，不是丟例外", () => {
    expect(extractJumpBlob("ordinary gdb output")).toBeNull();
    expect(extractJumpBlob(undefined)).toBeNull();
  });

  test("JSON 壞掉回 null——失敗模式是沒跳成功，不是教案壞掉", () => {
    expect(extractJumpBlob(`${FF_BEGIN}{not json${FF_END}`)).toBeNull();
  });

  test("輸出被截斷（只有開頭標記）也回 null", () => {
    expect(extractJumpBlob(`${FF_BEGIN}{"stacks":[]`)).toBeNull();
  });
});

describe("applyJumpBlob", () => {
  beforeEach(() => {
    const gv = global_variable as any;
    delete gv.__call_tree;
    gv.__line_visit_count = {};
    gv.__visited_lines = new Set();
  });

  const stack = (line: number, n: string) => [
    { func: "fib", addr: "0x1", line, fullname: "/tmp/fib.cpp", args: [{ name: "n", value: n }] },
    { func: "main", addr: "0x2", line: 14, fullname: "/tmp/fib.cpp", args: [] },
  ];

  test("落地行的計數扣掉一次，留給 inferior_program_paused 補", () => {
    // Actions.ts:143 會替落地行 +1。這裡不扣的話落地行會多算一次，
    // 而它正是後面所有 | @N 段落選擇的依據。
    applyJumpBlob({
      stacks: [stack(6, "9"), stack(7, "8")],
      counts: { "6": 5, "7": 13 },
      landed: true,
      steps: 2,
    });
    const counts = (global_variable as any).__line_visit_count;
    expect(counts["6"]).toBe(5);
    expect(counts["7"]).toBe(12); // 13 - 1
  });

  test("回傳落地 frame，且把走過的行都記進 __visited_lines", () => {
    const landing: any = applyJumpBlob({
      stacks: [stack(6, "9"), stack(7, "8")],
      counts: { "6": 1, "7": 1 },
      landed: true,
      steps: 2,
    });
    expect(landing.line).toBe(7);
    expect(landing.args[0].value).toBe("8");
    expect((global_variable as any).__visited_lines.has(6)).toBe(true);
  });

  test("空 blob 回 null，不要把呼叫圖清掉", () => {
    expect(applyJumpBlob({ stacks: [], counts: {}, landed: false, steps: 0 })).toBeNull();
  });

  test("灌完之後呼叫圖有節點——這是一次跳最重要的產出", () => {
    applyJumpBlob({
      stacks: [stack(6, "9"), stack(7, "8")],
      counts: { "6": 1, "7": 1 },
      landed: true,
      steps: 2,
    });
    expect(((global_variable as any).__call_graph_nodes || []).length).toBeGreaterThan(0);
  });
});
