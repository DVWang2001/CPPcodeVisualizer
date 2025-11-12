import { global_variable } from "./global_variable";
import GdbVariable from "./GdbVariable";
class VisualizerHelper {
  static processing_guide(frame_line) {
    if (!('__line' in global_variable && (parseInt(frame_line) !== NaN)))return;
    // 尋找該line是否有指導
    if (!(frame_line in global_variable.__line)) return;
    const regex = /(T)?\s*\(\s*([a-zA-Z_0-9+\-*/=<>!&|%()\s,]+)\s*\)/;
    const match = global_variable.__line[frame_line].match(regex);
    if (!match) return;
    const hasLeadingT = !!match[1]; // 如果 match[1] 存在，則有前導 T
    console.log(`實際上的內容：${global_variable.__line[frame_line]}`)
    console.log(`match[1] = ${match[1]}`);
    console.log(`是否有前導 T: ${hasLeadingT}`);
    const instructions = match[2].split(',');
    console.log(`成功讀取指導︰${instructions}`);
    // 設置標記
    global_variable.__hasLeadingT = hasLeadingT;
    // 處理每個指令
    VisualizerHelper.graphics_instruction(instructions,hasLeadingT);
  }
  static async graphics_instruction(instruction, hasLeadingT = false) {
    if (!("__guide" in global_variable)) global_variable.__guide = new Map();
    
    for (const inst of instruction) {
      const trimmedInst = inst.trim();
      const expressions = store.get("expressions");
      const existingVar = expressions.find(obj => obj.expression === trimmedInst && obj.in_scope === "true");
      if (existingVar) {
        // 如果已存在，先刪除以確保獲取最新值
        GdbVariable.delete_gdb_variable(existingVar.name);
      }
      // 總是創建新的變數對象以獲取最新值
      GdbVariable.create_variable(trimmedInst, "expr");

      // 等待並獲取結果
      const result = await new Promise((resolve) => {
        const checkStore = () => {
          const expressions = store.get("expressions");
          const varObj = expressions.find(obj => obj.expression === trimmedInst && obj.in_scope === "true");
          if (varObj) {
            resolve(varObj.value);
          } else {
            setTimeout(checkStore, 100);  // 每 100ms 檢查一次
          }
        };
        checkStore();
      });

      console.log(`單獨結果 for ${trimmedInst}: ${result}`);
      if (!(global_variable.__guide.has(trimmedInst)))global_variable.__guide.set(trimmedInst, []);
      global_variable.__guide.get(trimmedInst).push(result);
      console.log(JSON.stringify(Object.fromEntries(global_variable.__guide)));
    }
  }
}

export default VisualizerHelper;