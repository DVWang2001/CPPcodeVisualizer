import { loadDraft, saveDraft, clearDraft } from "../tableDraft";

beforeEach(() => localStorage.clear());

test("沒有草稿時回傳正確大小的空表", () => {
  expect(loadDraft("t1", 2, 3)).toEqual([["", "", ""], ["", "", ""]]);
});

test("存了就讀得回來", () => {
  saveDraft("t1", [["1", "2"], ["3", "4"]]);
  expect(loadDraft("t1", 2, 2)).toEqual([["1", "2"], ["3", "4"]]);
});

test("維度變了就丟棄草稿，不回傳半張表", () => {
  saveDraft("t1", [["1", "2"], ["3", "4"]]);
  expect(loadDraft("t1", 3, 3)).toEqual([
    ["", "", ""], ["", "", ""], ["", "", ""]
  ]);
});

test("不同題目的草稿互不干擾", () => {
  saveDraft("t1", [["1"]]);
  expect(loadDraft("t2", 1, 1)).toEqual([[""]]);
});

test("清除之後回到空表", () => {
  saveDraft("t1", [["1"]]);
  clearDraft("t1");
  expect(loadDraft("t1", 1, 1)).toEqual([[""]]);
});

test("壞掉的 JSON 不會讓作答頁整個掛掉", () => {
  localStorage.setItem("gdbgui_table_draft:t1", "{壞掉的");
  expect(loadDraft("t1", 1, 1)).toEqual([[""]]);
});

test("非字串儲存格會丟棄整張草稿", () => {
  localStorage.setItem("gdbgui_table_draft:t1", JSON.stringify([["1", 2]]));
  expect(loadDraft("t1", 1, 2)).toEqual([["", ""]]);
});

test("storage 讀取失敗時回傳空表", () => {
  const getItem = jest.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("storage unavailable");
  });
  expect(loadDraft("t1", 1, 2)).toEqual([["", ""]]);
  getItem.mockRestore();
});

test("storage 寫入失敗時不拋錯", () => {
  const setItem = jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("storage unavailable");
  });
  expect(() => saveDraft("t1", [["1"]])).not.toThrow();
  setItem.mockRestore();
});

test("storage 清除失敗時不拋錯", () => {
  const removeItem = jest.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
    throw new Error("storage unavailable");
  });
  expect(() => clearDraft("t1")).not.toThrow();
  removeItem.mockRestore();
});
