import { clearStrokes, loadStrokes, saveStrokes } from "../scratchStrokes";

beforeEach(() => localStorage.clear());

test("沒有草稿時回空陣列", () => {
  expect(loadStrokes("q1")).toEqual([]);
});

test("存了就讀得回來", () => {
  saveStrokes("q1", [[{ x: 0.1, y: 0.2 }, { x: 0.3, y: 0.4 }]]);

  expect(loadStrokes("q1")).toEqual([[{ x: 0.1, y: 0.2 }, { x: 0.3, y: 0.4 }]]);
});

test("不同題目的草稿互不干擾", () => {
  saveStrokes("q1", [[{ x: 0.5, y: 0.5 }]]);

  expect(loadStrokes("q2")).toEqual([]);
});

test("清除之後回到空的", () => {
  saveStrokes("q1", [[{ x: 0.5, y: 0.5 }]]);
  clearStrokes("q1");

  expect(loadStrokes("q1")).toEqual([]);
});

test("壞掉的 JSON 不會讓作答頁整個掛掉", () => {
  localStorage.setItem("gdbgui_scratch:q1", "{壞掉的");

  expect(loadStrokes("q1")).toEqual([]);
});

test("座標不是 0..1 的正規化數值就整份丟棄", () => {
  // 座標是正規化的（0..1），這樣手機轉向、鍵盤彈出改變畫布尺寸時才能照新尺寸重畫。
  // 存到超出範圍或非數字的值，代表寫入端壞了——照著畫會得到畫布外的線條，不如當作沒有。
  localStorage.setItem("gdbgui_scratch:q1", JSON.stringify([[{ x: 1.5, y: 0.2 }]]));
  expect(loadStrokes("q1")).toEqual([]);

  localStorage.setItem("gdbgui_scratch:q2", JSON.stringify([[{ x: "a", y: 0.2 }]]));
  expect(loadStrokes("q2")).toEqual([]);
});

test("空筆畫不會被存下來", () => {
  // 手指點一下沒有移動會產生零長度的筆畫，存下來只是噪音。
  saveStrokes("q1", [[], [{ x: 0.1, y: 0.1 }]]);

  expect(loadStrokes("q1")).toEqual([[{ x: 0.1, y: 0.1 }]]);
});
