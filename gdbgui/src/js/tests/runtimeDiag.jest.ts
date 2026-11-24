// 執行錯誤圖解（P2）的資料層：每個畫面要的值都從這次執行的錯誤紀錄與軌跡算出來。
// 固定資料 fixtures/runtimeRuns.json 是 lab-david 上 P1 引擎的真實執行結果（suite-p2fix.sh → log-p2fix.txt），
// 步驟經過 LocalGdb 的 TraceModel，和前端從 session.model 讀到的一樣。
import { diagnose, byteColToIndex, listRuntimeErrors, RtRun, RtDiag } from "../runtimeDiag";

const FIX = require("./fixtures/runtimeRuns.json");

function runOf(id: string): RtRun {
  const r = FIX.runs[id];
  if (!r) throw new Error("no fixture " + id);
  const steps: any[] = new Array(r.nSteps);
  r.steps.forEach((p: [number, any]) => {
    steps[p[0]] = p[1];
  });
  return { errors: r.runtimeErrors, exit: r.exit, steps, source: r.src, functions: r.functions, decls: r.decls, classes: r.classes };
}

const badText = (d: RtDiag) => (d.bad ? d.code.slice(d.bad[0], d.bad[1]) : null);
const origin = (d: RtDiag, name: string) => d.origins.filter((o) => o.name === name)[0];
const fixText = (d: RtDiag) => (d.fix ? d.fix.code.map((l) => l.text).join("\n") : "");

describe("byteColToIndex：錯誤紀錄的欄位是 UTF-8 位元組", () => {
  test("有中文的行：第 81 個位元組是第 65 個字（index 64）", () => {
    const line = FIX.runs.ex_err_null_deref.src.split("\n")[20];
    expect(byteColToIndex(line, 81)).toBe(64);
    expect(line.slice(64, 67)).toBe("val");
  });
  test("純 ASCII 的行：位元組欄位就是字元欄位", () => {
    expect(byteColToIndex("  int c = a / b;", 13)).toBe(12);
  });
  test("超過行尾：回傳行長", () => {
    expect(byteColToIndex("abc", 99)).toBe(3);
  });
});

describe("listRuntimeErrors：這次執行有哪些錯誤畫面", () => {
  test("一般錯誤用索引，堆疊用完用 stack-overflow，正常結束沒有", () => {
    expect(listRuntimeErrors(runOf("div0_input"))).toEqual([0]);
    expect(listRuntimeErrors(runOf("inf_recursion"))).toEqual(["stack-overflow"]);
    expect(listRuntimeErrors(runOf("deep_recursion"))).toEqual([]);
  });
});

describe("家族 1：數值", () => {
  test("除以零（值來自輸入）：運算元、除號底線、值的來源是 cin 那一行", () => {
    const d = diagnose(runOf("div0_input"), 0);
    expect(d.kind).toBe("div-by-zero");
    expect(d.family).toBe("家族 1・數值");
    expect(d.fatal).toBe(true);
    expect(d.title).toBe("整數除以零");
    expect(d.line).toBe(6);
    expect(d.step).toBe(1);
    expect(badText(d)).toBe("/");
    expect(d.pic).toMatchObject({ op: "/", lhs: 7, rhs: 0, lhsText: "a", rhsText: "b", rhsName: "b" });
    expect(origin(d, "b")).toMatchObject({ step: 0, line: 5, red: true });
    expect(origin(d, "b").desc).toContain("cin >> a >> b;");
    expect(origin(d, "a")).toMatchObject({ step: 0, line: 5 });
    expect(fixText(d)).toContain("if (b == 0) {");
    expect(d.native).toContain("Floating point exception");
    expect(d.raw).toBe("division by zero");
  });

  test("除數是算式：沒有變數可以追，修正寫法把算式包進條件", () => {
    const d = diagnose(runOf("div_expr"), 0);
    expect(d.pic).toMatchObject({ lhs: 7, rhs: 0, rhsText: "(b - 3)", rhsName: null });
    expect(d.origins.map((o) => o.name)).toEqual(["a"]);
    expect(fixText(d)).toContain("if ((b - 3) == 0) {");
  });

  test("取餘數 % 0：標題與底線是 %，左邊是常數", () => {
    const d = diagnose(runOf("mod0_loop"), 0);
    expect(d.title).toBe("取餘數（%）時除以零");
    expect(badText(d)).toBe("%");
    expect(d.pic).toMatchObject({ op: "%", lhs: 10, rhs: 0, lhsText: "10", rhsName: "i" });
    expect(origin(d, "i")).toMatchObject({ step: 0, line: 4 });
  });

  test("有號溢位（階乘）：正確答案、存進去的值、位元與值的來源", () => {
    const d = diagnose(runOf("ex_err_int_overflow"), 0);
    expect(d.kind).toBe("signed-overflow");
    expect(d.fatal).toBe(false);
    expect(d.title).toBe("有號整數溢位");
    expect(d.line).toBe(10);
    expect(d.step).toBe(48);
    expect(badText(d)).toBe("result * i");
    expect(d.pic).toMatchObject({ op: "*", lhs: 479001600, rhs: 13, width: 32, exact: "6227020800", stored: "1932053504", wraps: 1 });
    expect(d.pic.exactBits).toBe("101110011001010001100110000000000");
    expect(d.pic.storedBits).toBe("01110011001010001100110000000000");
    // result 是上一圈同一行寫的；i 是第 9 行 for 的 i++
    expect(origin(d, "result")).toMatchObject({ step: 46, line: 10, sameLine: true });
    expect(origin(d, "result").desc).toBe("上一次執行第 10 行時算出來的（那時 i = 12）");
    expect(origin(d, "i")).toMatchObject({ step: 47, line: 9 });
    expect(origin(d, "i").desc).toContain("把 i 從 12 變成 13");
    expect(fixText(d)).toBe("long long factorial(int n) {\n    long long result = 1;");
    expect(d.pic).toMatchObject({ modulus: "4294967296", assignTo: "result" });
    expect(d.native).toContain("不會報錯");
  });

  test("有號溢位（加法）：剛好 32 位元，第一格正負號變成 1", () => {
    const d = diagnose(runOf("ovf_add"), 0);
    expect(badText(d)).toBe("x + 1");
    expect(d.pic).toMatchObject({ exact: "2147483648", stored: "-2147483648" });
    expect(d.pic.exactBits).toBe("1" + "0".repeat(31));
    expect(d.pic.storedBits).toBe("1" + "0".repeat(31));
    expect(origin(d, "x")).toMatchObject({ step: 0, line: 4 });
  });

  test("有號溢位在函式裡：參數的來源是呼叫的那一行", () => {
    const d = diagnose(runOf("ovf_fn"), 0);
    expect(d.pic).toMatchObject({ exact: "3000000000", stored: "-1294967296" });
    expect(origin(d, "x")).toMatchObject({ step: 1, line: 8, how: "param" });
    expect(origin(d, "x").desc).toBe("第 8 行呼叫 `twice(big)` 時傳進來的");
    // 結果要 return：參數與回傳型別都要改，否則溢位只是移到 return
    expect(fixText(d)).toBe("long long twice(long long x) {");
  });

  test("有號溢位在 for 的更新式：上一圈同一行寫的；迴圈靠溢位才停時不給 long long 的改法", () => {
    const d = diagnose(runOf("ovf_loop"), 0);
    expect(badText(d)).toBe("i * 2");
    expect(origin(d, "i")).toMatchObject({ step: 61, line: 5, sameLine: true });
    expect(d.fix!.code).toEqual([]);
    expect(d.fix!.text).toContain("i > 0");
  });
});

describe("家族 2：陣列與容器", () => {
  test("C 陣列越界（struct 成員）：格子、索引來源、寫出去之後蓋掉了 guard", () => {
    const d = diagnose(runOf("ex_err_array_oob"), 0);
    expect(d.kind).toBe("array-bounds");
    expect(d.family).toBe("家族 2・陣列與容器");
    expect(d.fatal).toBe(false);
    expect(d.title).toBe("陣列索引超出範圍");
    expect(d.line).toBe(17);
    expect(badText(d)).toBe("b.data[i]");
    expect(d.pic).toMatchObject({ arrayText: "b.data", size: 4, index: 4, indexText: "i", cells: [0, 10, 20, 30], write: true });
    expect(origin(d, "i")).toMatchObject({ step: 10, line: 16 });
    expect(origin(d, "i").desc).toBe("第 16 行 for 的 `i++` 把 i 從 3 變成 4；條件 `i <= 4` 還成立，所以又進了迴圈");
    expect(d.pic.after).toMatchObject({ step: 12, overwritten: [{ path: "b.guard", from: 42, to: 40, sibling: true }] });
    expect(fixText(d)).toContain("i < 4");
  });

  test("二維陣列欄越界：越界的是 [c]，寫到下一列的 g[2][0]", () => {
    const d = diagnose(runOf("arr2d_oob"), 0);
    expect(badText(d)).toBe("g[r][c]");
    expect(d.pic).toMatchObject({ arrayText: "g[r]", size: 3, index: 3, indexText: "c", cells: [0, 0, 0] });
    expect(d.pic.after.overwritten).toEqual([{ path: "g[2][0]", from: 0, to: 9, sibling: false, sameArray: true }]);
    expect(origin(d, "c")).toMatchObject({ step: 1, line: 5 });
  });

  test("一行的 for：索引變數在這一步看不到，來源就是這一行；沒有改到其他看得見的變數", () => {
    const d = diagnose(runOf("arr_local"), 0);
    expect(badText(d)).toBe("a[i]");
    expect(d.pic).toMatchObject({ index: 3, size: 3, indexText: "i", cells: [1, 2, 3] });
    expect(origin(d, "i")).toMatchObject({ step: 2, line: 6, how: "here" });
    expect(d.pic.after.overwritten).toEqual([]);
  });

  test("越界讀取：索引來自 cin，不畫寫入之後的圖", () => {
    const d = diagnose(runOf("arr_oob_read"), 0);
    expect(d.pic).toMatchObject({ index: 7, size: 5, write: false });
    expect(origin(d, "i")).toMatchObject({ step: 1, line: 6, how: "cin" });
  });

  test("vector[] 越界：libc++ 只有行號，值從軌跡取", () => {
    const d = diagnose(runOf("vec_oob"), 0);
    expect(d.kind).toBe("container-index");
    expect(d.fatal).toBe(true);
    expect(d.title).toBe("vector 索引超出範圍");
    expect(d.line).toBe(6);
    expect(badText(d)).toBe("v[i]");
    expect(d.pic).toMatchObject({ name: "v", size: 5, capacity: 5, index: 5, indexText: "i", cells: [0, 1, 2, 3, 4], isString: false });
    expect(origin(d, "i")).toMatchObject({ step: 11, line: 5 });
    expect(origin(d, "i").desc).toBe("第 5 行 for 的 `i++` 把 i 從 4 變成 5；條件 `i <= 5` 還成立，所以又進了迴圈");
    expect(origin(d, "v")).toMatchObject({ step: 0, line: 4, label: "v 有 5 個元素" });
    expect(origin(d, "v").desc).toBe("第 4 行 `vector<int> v(5);` 宣告的");
    expect(fixText(d)).toContain("i < 5");
    expect(d.raw).toBe("vector[] index out of bounds");
  });

  test("string[] 越界：字元格子，索引是常數", () => {
    const d = diagnose(runOf("str_oob"), 0);
    expect(d.title).toBe("string 索引超出範圍");
    expect(d.pic).toMatchObject({ name: "s", size: 3, index: 10, indexText: "10", cells: ["a", "b", "c"], isString: true });
    // 索引是常數，沒有變數可以追；字串的長度來自宣告那一行（和設計稿 vector 卡的「v 有 5 格」同一種來源）
    expect(d.origins.map((o) => o.name)).toEqual(["s"]);
    expect(origin(d, "s")).toMatchObject({ step: 0, line: 4, how: "decl" });
    expect(d.originNote).toContain("10");
  });

  test.each([
    ["stack_empty_top", "對空的 stack 呼叫 top()", "s.top()", 2, 6],
    ["stack_pop_empty", "對空的 stack 呼叫 pop()", "s.pop()", 0, 4],
    ["queue_empty_front", "對空的 queue 呼叫 front()", "q.front()", 0, 4],
    ["vec_empty_back", "對空的 vector 呼叫 back()", "v.back()", 0, 4],
    ["vec_pop_empty", "對空的 vector 呼叫 pop_back()", "v.pop_back()", 0, 4],
    ["pq_empty_top", "對空的 priority_queue 呼叫 top()", "pq.top()", 2, 6],
  ])("空容器 %s：標題用學生寫的呼叫，來源是容器變空的那一步", (id, title, bad, step, line) => {
    const d = diagnose(runOf(id as string), 0);
    expect(d.kind).toBe("empty-container");
    expect(d.title).toBe(title);
    expect(badText(d)).toBe(bad);
    const name = (bad as string).split(".")[0];
    expect(origin(d, name)).toMatchObject({ step, line });
    expect(fixText(d)).toContain(`if (!${name}.empty()) {`);
  });

  test("空 stack 的 top()：原始訊息說的是 deque::back，附註說明原因", () => {
    const d = diagnose(runOf("stack_empty_top"), 0);
    expect(d.pic).toMatchObject({ name: "s", method: "top", ckind: "stack" });
    expect(d.raw).toBe("deque::back called on an empty deque");
    expect(d.rawNote).toContain("deque");
    expect(origin(d, "s").desc).toBe("第 6 行 `s.pop();` 拿走了最後一個元素（1）");
    expect(d.what[0]).toBe("`s.top()` 要拿 stack 最上面的元素，可是 `s` 裡一個元素都沒有，沒有東西可以拿。");
  });
});

describe("家族 3：指標", () => {
  test("cur->next->val：沒有箭頭的物件圖，nullptr 的欄位標出來", () => {
    const d = diagnose(runOf("ex_err_null_deref"), 0);
    expect(d.kind).toBe("null-deref");
    expect(d.family).toBe("家族 3・指標與記憶體");
    expect(d.title).toBe("透過空指標存取成員");
    expect(d.line).toBe(21);
    expect(badText(d)).toBe("cur->next->val");
    expect(d.pic).toMatchObject({ baseText: "cur->next", member: "val" });
    expect(d.pic.objects).toEqual([
      { name: "b", type: "Node", fields: [{ name: "val", value: "20", ptr: false, isNull: false }, { name: "next", value: "nullptr", ptr: true, isNull: true }] },
      { name: "a", type: "Node", fields: [{ name: "val", value: "10", ptr: false, isNull: false }, { name: "next", value: "不是 nullptr", ptr: true, isNull: false }] },
    ]);
    expect(d.pic.pointers).toEqual([{ name: "cur", type: "Node *", isNull: false }]);
    expect(origin(d, "cur")).toMatchObject({ step: 5, line: 22 });
    // nullptr 的欄位是哪個物件的、在哪裡寫進去的
    expect(origin(d, "b.next")).toMatchObject({ step: 0, line: 16, label: "b.next = nullptr" });
    expect(d.what[1]).toBe("看得到的 Node 裡，只有 b 的 next 是 nullptr。");
    expect(fixText(d)).toContain("if (cur->next != nullptr) {");
  });

  test("p->val 而 p 是 nullptr：指標本身標紅，來源是 p = p->next", () => {
    const d = diagnose(runOf("null_heap"), 0);
    expect(badText(d)).toBe("p->val");
    expect(d.pic.objects).toEqual([]);
    expect(d.pic.pointers).toEqual([{ name: "head", type: "Node *", isNull: false }, { name: "p", type: "Node *", isNull: true }]);
    expect(origin(d, "p")).toMatchObject({ step: 6, line: 12, red: true });
  });

  test.each([
    ["null_read", "透過空指標讀取"],
    ["null_write", "透過空指標寫入"],
  ])("%s：*p 的標題與底線", (id, title) => {
    const d = diagnose(runOf(id as string), 0);
    expect(d.title).toBe(title);
    expect(badText(d)).toBe("*p");
    expect(d.pic).toMatchObject({ baseText: "p", member: null });
    expect(origin(d, "p")).toMatchObject({ step: 0, line: 4 });
  });
});

describe("家族 4：函式與流程", () => {
  test("缺 return：標第 6 行的 }，路徑上每個 if 都不成立", () => {
    const d = diagnose(runOf("missing_return"), 0);
    expect(d.kind).toBe("missing-return");
    expect(d.title).toBe("函式走到結尾都沒有 return");
    expect(d.line).toBe(6);
    expect(badText(d)).toBe("}");
    expect(d.pic.fn).toBe("sign");
    expect(d.pic.params).toEqual([{ name: "x", value: "0" }]);
    expect(d.pic.path.map((p: any) => [p.line, p.note])).toEqual([
      [4, "0 > 0 不成立"],
      [5, "0 < 0 不成立"],
      [6, "到了結尾，沒有 return"],
    ]);
    expect(origin(d, "x")).toMatchObject({ step: 0, line: 8, how: "param" });
    expect(fixText(d)).toContain("return 0;");
    expect(d.raw).toContain("without returning a value");
  });

  test("無窮遞迴（沒有停止條件）：塔的上下各幾層，中間省略的層數", () => {
    const d = diagnose(runOf("inf_recursion"), "stack-overflow");
    expect(d.kind).toBe("stack-overflow");
    expect(d.title).toBe("遞迴停不下來，堆疊用完了");
    expect(d.fatal).toBe(true);
    expect(d.line).toBe(4);
    expect(d.step).toBe(62127);
    expect(badText(d)).toBe("f(n - 1)");
    expect(d.pic).toMatchObject({ fn: "f", depth: 62128, infinite: true, gap: 62119 });
    expect(d.pic.top.map((f: any) => f.label)).toEqual(["f(n = -62123)", "f(n = -62122)", "f(n = -62121)"]);
    expect(d.pic.bottom.map((f: any) => f.label)).toEqual(["f(n = -1)", "f(n = 0)", "f(n = 1)", "f(n = 2)", "f(n = 3)", "main()"]);
    expect(origin(d, "f")).toMatchObject({ step: 0, line: 7 });
    expect(d.raw).toContain("recursion too deep");
  });

  test("有停止條件但一直不成立：中性的標題，說明 n 永遠不會等於 0", () => {
    const d = diagnose(runOf("rec_cond"), "stack-overflow");
    expect(d.title).toBe("呼叫太多層，堆疊用完了");
    expect(d.pic).toMatchObject({ infinite: false, depth: 55225 });
    expect(d.pic.neverHit).toEqual({ name: "n", target: 0, start: 3, delta: -2 });
  });
});

describe("其他錯誤：還沒有專屬的畫面", () => {
  test.each(["intmin_div", "shift_big", "vec_at"])("%s 用預設畫面並附原始訊息", (id) => {
    const r = runOf(id as string);
    const d = diagnose(r, 0);
    expect(d.kind).toBe("other");
    expect(d.raw).toBe(r.errors[0].message);
  });
});
