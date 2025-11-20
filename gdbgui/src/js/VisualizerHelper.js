import { global_variable } from "./global_variable";
import GdbVariable from "./GdbVariable";
class VisualizerHelper {
  static processing_guide(frame_line) {
    if (!('__line' in global_variable && (parseInt(frame_line) !== NaN)))return;
    // 尋找該line是否有指導
    if (!(frame_line in global_variable.__line)) return;
    const content = VisualizerHelper.extractBalancedBraces(global_variable.__line[frame_line]);
    VisualizerHelper.graphics_instruction(content,frame_line);
  }
  static async graphics_instruction(instruction,frame_line) {
    if (!("__guide" in global_variable)) global_variable.__guide = new Map();
    let outputArray = [];
    for (const inst of instruction) {
      if (!(inst.startsWith('{') && inst.endsWith('}'))) {
        outputArray.push(inst);
        continue;
      }
      const trimmedInst = inst.slice(1, -1).trim();
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
      outputArray.push(result);
    }
    const outputString = outputArray.join('');
    // 將字面上的 \n 替換為實際的換行符 \n
    const processedString = outputString.replace(/\\n/g, '\n');
    //若該行指導還沒建立，先建立
    if (!(global_variable.__guide.has(frame_line)))global_variable.__guide.set(frame_line, []);
    
    // 在 push 之前，填充所有 key 的陣列到最長陣列的長度
    const allArrays = Array.from(global_variable.__guide.values());
    const maxLength = Math.max(...allArrays.map(arr => arr.length));
    for (const arr of allArrays) {
      while (arr.length < maxLength) {
        arr.push(' ');
      }
    }
    
    // 如果 processedString 包含 \n，就 split 成多個部分，每個部分 push 到對應的行
    const parts = processedString.split('\n');
    for (let i = 0; i < parts.length; i++) {
      const targetFrame = (parseInt(frame_line) + i).toString();
      if (!(global_variable.__guide.has(targetFrame))) global_variable.__guide.set(targetFrame, []);
      const targetArray = global_variable.__guide.get(targetFrame);
      const part = parts[i];
      // 如果目標陣列的最後一個元素為 ' '，則 pop 再 push，否則直接 push
      if (targetArray.length > 0 && targetArray[targetArray.length - 1] === ' ') {
        targetArray.pop();
      }
      targetArray.push(part);
    }
    console.log(JSON.stringify(Object.fromEntries(global_variable.__guide)));
  }

  static extractBalancedBraces(str) {
    const parts = [];
    let i = 0;
    while (i < str.length) {
      if (str[i] === '{') {
        let braceCount = 1;
        let start = i + 1;
        i++;
        while (i < str.length && braceCount > 0) {
          if (str[i] === '{') {
            braceCount++;
          } else if (str[i] === '}') {
            braceCount--;
          }
          i++;
        }
        if (braceCount === 0) {
          const content = str.substring(start, i - 1);
          parts.push(`{${content}}`);
        }
      } else {
        parts.push(str[i]);
        i++;
      }
    }
    return parts;
  }
}

export default VisualizerHelper;