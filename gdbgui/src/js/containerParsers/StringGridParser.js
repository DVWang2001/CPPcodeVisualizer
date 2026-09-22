import ContainerParser from "./ContainerParser";

// vector<std::string>（或 array/deque/list<std::string>）常被拿來存文字地圖：
// 每個字串是一列，字元是通道/牆。把它拆成字元的二維陣列，讓既有的 2D 格狀視圖
// 和 {grid[i][j]} 2D 高亮邏輯直接吃得下，不必為地圖另外做一套渲染路徑。
//
// 只在「每個子元素都是引號括起來的字串」時才接手，所以 vector<int> 等其他容器
// 完全不受影響——GDB 的 std::string pretty-printer 一律把值印成帶引號的字面量，
// 跟 vector/deque 那種 "of length N" 的子容器摘要在格式上不會混淆。
const isStringLike = (c) =>
  typeof c.value === "string" && c.value.length >= 2 &&
  c.value.startsWith('"') && c.value.endsWith('"');

class StringGridParser extends ContainerParser {
  canHandle(containerName, varObj) {
    if (!["vector", "array", "deque", "list"].includes(containerName)) return false;
    const children = varObj.children || [];
    return children.length > 0 && children.every(isStringLike);
  }

  parse(varObj, _context) {
    const values = varObj.children.map((c) => c.value.slice(1, -1).split(""));
    return { done: true, values };
  }
}

export default StringGridParser;
