import { parseSwapCall } from "../swapDetect";

describe("parseSwapCall", () => {
  test("認出 swap(arr[j], arr[j + 1])", () => {
    expect(parseSwapCall("                swap(arr[j], arr[j + 1]);")).toEqual({
      containerName: "arr",
      indexExprA: "j",
      indexExprB: "j + 1",
    });
  });

  test("認 std::swap 前綴", () => {
    expect(parseSwapCall("std::swap(arr[i], arr[j]);")).toEqual({
      containerName: "arr",
      indexExprA: "i",
      indexExprB: "j",
    });
  });

  test("行尾 //@ 註解不影響解析（只看程式碼那一半）", () => {
    expect(parseSwapCall("swap(v[a], v[b]); //@ @tts [next] 交換")).toEqual({
      containerName: "v",
      indexExprA: "a",
      indexExprB: "b",
    });
  });

  test("索引是函式呼叫（逗號在括號內不誤切）", () => {
    expect(parseSwapCall("swap(arr[f(1,2)], arr[j]);")).toEqual({
      containerName: "arr",
      indexExprA: "f(1,2)",
      indexExprB: "j",
    });
  });

  test("不是 swap 呼叫：手寫三段式交換認不出來，回 null（交給值比對兜底）", () => {
    expect(parseSwapCall("tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;")).toBeNull();
  });

  test("iter_swap／不是方括號索引：回 null", () => {
    expect(parseSwapCall("iter_swap(it1, it2);")).toBeNull();
    expect(parseSwapCall("swap(v.at(i), v.at(j));")).toBeNull();
  });

  test("交換的是兩個不同容器：回 null（語意上不是同容器換位置）", () => {
    expect(parseSwapCall("swap(a[i], b[j]);")).toBeNull();
  });

  test("參數不是剛好兩個：回 null", () => {
    expect(parseSwapCall("swap(arr[i]);")).toBeNull();
  });

  test("沒有 swap 呼叫的普通行：回 null", () => {
    expect(parseSwapCall("int n = arr.size();")).toBeNull();
  });

  test("空字串／undefined 安全回 null", () => {
    expect(parseSwapCall("")).toBeNull();
    expect(parseSwapCall(undefined as any)).toBeNull();
  });
});
