import { global_variable } from "./global_variable";
import { store } from "statorgfc";
import GdbVariable from "./GdbVariable";

// ── TTS 播放狀態（模組級）────────────────────────────────────────────
let _tts_task_id = 0;           // 每次 play_tts 遞增，舊任務比對不符就自動放棄
let _tts_current_audio = null;  // 目前播放中的 Audio 元素，供中斷使用

/** 停止目前播放的音訊。 */
function _tts_cancel() {
  if (_tts_current_audio) {
    _tts_current_audio.pause();
    _tts_current_audio.src = '';
    _tts_current_audio = null;
  }
}

/** 暫停目前播放的音訊，回傳恢復所需的資訊（url + currentTime）。 */
function _tts_pause() {
  if (!_tts_current_audio || _tts_current_audio.paused) return null;
  const url = _tts_current_audio.src;
  const currentTime = _tts_current_audio.currentTime;
  _tts_current_audio.pause();
  return { url, currentTime };
}

/** 從暫停點繼續播放，並在結束時執行 autoplayCommand。 */
function _tts_resume(resumeInfo, autoplayCommand) {
  if (!resumeInfo || !resumeInfo.url) return;
  const audio = new Audio();
  _tts_current_audio = audio;

  const finish = () => {
    if (_tts_current_audio === audio) _tts_current_audio = null;
    window._gdbgui_tts_playing = null;
    window._gdbgui_tts_resume = null;
    if (typeof window.gdbgui_on_tts_end === 'function') window.gdbgui_on_tts_end();
    if (autoplayCommand && typeof window.gdbgui_execute_autoplay_command === 'function') {
      window.gdbgui_execute_autoplay_command(autoplayCommand);
    }
  };

  audio.onended = finish;
  audio.onerror = () => { console.warn('[TTS] Resume playback error'); finish(); };

  audio.src = resumeInfo.url;
  // 等 canplay 後再 seek 並套用速度（load() 會重置 playbackRate）
  audio.addEventListener('canplay', () => {
    audio.playbackRate = (store.get('tts_speed')) || 1.0;
    audio.currentTime = resumeInfo.currentTime || 0;
    audio.play().catch(() => finish());
  }, { once: true });
  audio.load();
}

/**
 * 向後端 /tts_audio 請求 MP3 音訊，並以 <audio> 元素播放。
 * 完全繞過 Web Speech API，不再有 Chrome 的 cancel/speak 競態問題。
 * 播放完畢後執行 autoplayCommand 並通知字幕清除。
 */
function _tts_play_audio(url, taskId, autoplayCommand) {
  return new Promise((resolve) => {
    if (taskId !== _tts_task_id) { resolve(); return; }

    const audio = new Audio();
    _tts_current_audio = audio;

    const finish = () => {
      if (_tts_current_audio === audio) _tts_current_audio = null;
      if (taskId !== _tts_task_id) { resolve(); return; }
      window._gdbgui_tts_playing = null;
      window._gdbgui_tts_resume = null;
      if (typeof window.gdbgui_on_tts_end === 'function') window.gdbgui_on_tts_end();
      if (autoplayCommand && typeof window.gdbgui_execute_autoplay_command === 'function') {
        window.gdbgui_execute_autoplay_command(autoplayCommand);
      }
      resolve();
    };

    audio.onended = finish;
    audio.onerror = () => { console.warn('[TTS] Audio playback error'); finish(); };

    // 等 canplay 事件確認瀏覽器已 buffer 足夠資料再 play()，
    // 避免 MP3 encoder delay + 網路延遲造成開頭被截。
    // 看門狗：5 秒內若 canplay 仍未觸發（離線 / server 慢），直接嘗試播放。
    let canplayFired = false;
    const watchdog = setTimeout(() => {
      if (!canplayFired) {
        // load() 會重置 playbackRate，在此重新套用
        audio.playbackRate = (store.get('tts_speed')) || 1.0;
        audio.play().catch(() => finish());
      }
    }, 5000);

    audio.addEventListener('canplay', () => {
      canplayFired = true;
      clearTimeout(watchdog);
      // load() 會重置 playbackRate，在 canplay 後才設定確保生效
      audio.playbackRate = (store.get('tts_speed')) || 1.0;
      audio.play().catch(() => finish());
    }, { once: true });

    audio.src = url;
    audio.load();
  });
}

// 供其他模組（Actions.ts、GdbApi.tsx）操控 audio 元素的統一介面
window._tts_api = {
  cancel: _tts_cancel,
  pause: _tts_pause,
  resume: _tts_resume,
  _current: () => _tts_current_audio,  // 供 speedbar 即時調整 playbackRate
};

class VisualizerHelper {
  static processing_guide(frame_line, funcName) {
    if (!('__line' in global_variable)) return;
    const lineNum = parseInt(frame_line);
    if (isNaN(lineNum)) return;
    // 同時支援數字 key 與字串 key（localStorage 儲存的 key 是字串，handleInputChange 是數字）
    const guideContent = global_variable.__line[lineNum] || global_variable.__line[String(lineNum)];
    if (!guideContent) return;

    // --- 攔截 [自訂標籤#顏色] 語法給 Call Graph 使用 ---
    // 支援 `[標籤名稱#顏色] {變數}` 或是 `[標籤名稱] {變數}`
    const labelRegex = /^\[([^\]#]+)(?:#([^\]]+))?\](.*)/;
    const labelMatch = guideContent.match(labelRegex);
    
    if (!global_variable.__call_graph_custom_labels) {
      global_variable.__call_graph_custom_labels = {};
    }

    let graphicsContent = guideContent;
    if (labelMatch) {
      const labelName = labelMatch[1].trim();
      const color = labelMatch[2] ? labelMatch[2].trim() : null; // 可選的顏色
      const remainingContent = labelMatch[3].trim();
      
      // 提取該行要監聽的所有 {變數}
      const varsToWatch = VisualizerHelper.extractBalancedBraces(remainingContent)
        .filter(v => v.startsWith('{') && v.endsWith('}'))
        .map(v => v.slice(1, -1).trim());

      global_variable.__call_graph_custom_labels[lineNum] = {
        labelName,
        color,
        vars: varsToWatch, // 變數名稱清單，稍後在 CallGraph 中取得其值
        originalLine: lineNum
      };
      
      graphicsContent = remainingContent; // 後續交給 graphics_instruction 處理畫圖的部分
    } else {
        // 如果沒有匹配到，就清除該行的自訂標籤 (避免殘留舊的執行狀態)
        delete global_variable.__call_graph_custom_labels[lineNum];
    }
    // ----------------------------------------------------

    const content = VisualizerHelper.extractBalancedBraces(graphicsContent);
    VisualizerHelper.graphics_instruction(content, frame_line, funcName);
  }

  static async play_tts(frame_line, funcName) {
    const myTaskId = ++_tts_task_id; // 新任務 ID，舊任務將自動放棄
    _tts_cancel();                   // 立即停止目前播放的音訊
    console.log(`[play_tts] Called with frame_line: ${frame_line}, funcName: ${funcName}`);
    if (!('__tts' in global_variable)) {
      console.log(`[play_tts] __tts not found in global_variable`);
      return;
    }
    const lineNum = parseInt(frame_line);
    if (isNaN(lineNum)) return;
    const rawTtsContent = global_variable.__tts[lineNum] || global_variable.__tts[String(lineNum)];
    console.log(`[play_tts] Extracted ttsContent: ${rawTtsContent}`);
    if (!rawTtsContent) return;

    // ── 多次進入語法：用 | 分段，依進入次數選段落 ──────────────────
    // 每段可在開頭加 @N 指定「從第 N 次進入才開始說這段」：
    //   「第一次 | @3 第三次起 | @10 第十次以後」
    // 沒有 @N 時依序 1, 2, 3…（向下相容舊語法）：
    //   「第一次 | 第二次 | 第三次以後」
    let ttsContent = rawTtsContent;
    if (rawTtsContent.includes('|')) {
      const parts = rawTtsContent.split('|').map(s => s.trim());
      const visitCount = (global_variable.__line_visit_count && global_variable.__line_visit_count[lineNum]) || 1;

      // 解析每段的 threshold
      let nextDefault = 1;
      const segments = parts.map(part => {
        const atMatch = part.match(/^@(\d+)\s*/);
        if (atMatch) {
          const threshold = parseInt(atMatch[1]);
          nextDefault = threshold + 1;
          return { threshold, text: part.slice(atMatch[0].length) };
        }
        return { threshold: nextDefault++, text: part };
      });

      // 選取 threshold <= visitCount 的最後一段
      let selected = segments[0].text;
      for (const seg of segments) {
        if (visitCount >= seg.threshold) selected = seg.text;
      }
      ttsContent = selected;
    }

    // 解析自動播放指令前綴：[next] [step-in] [step-out] [continue]
    const cmdMatch = ttsContent.match(/^\[(next|step-in|step-out|continue)\]\s*/);
    const autoplayCommand = cmdMatch ? cmdMatch[1] : null;
    const ttsText = cmdMatch ? ttsContent.slice(cmdMatch[0].length) : ttsContent;

    // 將 TTS 取出的字串（去除指令前綴後）依照大括號進行拆分
    const instruction = VisualizerHelper.extractBalancedBraces(ttsText);
    let outputArray = [];
    console.log(`[play_tts] Extracted array:`, instruction);

    // 依序查詢所有的部分
    for (const inst of instruction) {
      // 1. 一般字串直接加進去
      if (!(inst.startsWith('{') && inst.endsWith('}'))) {
        outputArray.push(inst);
        continue;
      }

      // 2. 遇到 {變數}，先解析
      const trimmedInst = inst.slice(1, -1).trim();
      // 使用 tts:: 前綴，避免與 graphics_instruction 的變數抓取產生 Race Condition
      const displayKey = funcName ? `tts::${funcName}::${trimmedInst}` : `tts::${trimmedInst}`;

      const expressions = store.get("expressions");
      const existingVar = expressions.find(obj => obj.expression === displayKey && obj.in_scope === "true");
      if (existingVar) {
        GdbVariable.delete_gdb_variable(existingVar.name);
      }
      GdbVariable.create_variable(trimmedInst, "expr", displayKey);

      // 非同步輪詢獲取結果
      const result = await new Promise((resolve) => {
        let checkTicks = 0;
        const checkStore = () => {
          checkTicks++;
          if (checkTicks > 50) {
            console.warn(`[VisualizerHelper] play_tts TIMEOUT for expression: ${trimmedInst}`);
            resolve(trimmedInst); // 超時則發音原本的變數名
            return;
          }
          const exprs = store.get("expressions");
          const varObj = exprs.find(obj => obj.expression === displayKey && obj.in_scope === "true");
          if (varObj) {
            if (varObj.value !== undefined) {
              // 無論是容器還是一般變數，TTS 儘量發音其值 
              // 如果是字串或容器，這裡簡單的處理為直接取值
              resolve(varObj.value);
            } else {
              setTimeout(checkStore, 100);
            }
          } else {
            setTimeout(checkStore, 100);
          }
        };
        checkStore();
      });
      console.log(`[play_tts] Evaluated expression ${trimmedInst} -> ${result}`);
      // 收錄非同步查詢到的值
      outputArray.push(result);
    }

    // 合併所有被替換成實值的字串
    const evaluateSpokenText = outputArray.join('');
    console.log(`[play_tts] Formatted text across evaluated array: ${evaluateSpokenText}`);

    // 處理自定義發音 "字[音]" 轉換為 "音"
    // 例如： "白[柏]起打了一套拳" -> "柏起打了一套拳"
    const regex = /([^\[\]]+)\[([^\[\]]+)\]/g;
    const finalSpokenText = evaluateSpokenText.replace(regex, (_match, prefix, pronunciation) => {
      return prefix.slice(0, -1) + pronunciation;
    });

    // 變數替換完成後確認任務是否仍有效（非同步查詢期間可能有新任務進來）
    if (myTaskId !== _tts_task_id) return;

    // 先顯示字幕，再開始播放（避免 await 結束後字幕才設進去）
    store.set("tts_subtitle", {
      text: finalSpokenText,
      line: parseInt(frame_line),
      timestamp: Date.now()
    });

    // 向後端請求音訊並播放，完畢後執行 autoplayCommand
    window._gdbgui_tts_playing = { fullText: finalSpokenText, subtitleText: finalSpokenText, autoplayCommand, lastCharIndex: 0 };
    const audioUrl = `/tts_audio?text=${encodeURIComponent(finalSpokenText)}`;
    await _tts_play_audio(audioUrl, myTaskId, autoplayCommand);
  }

  static async graphics_instruction(instruction, frame_line, funcName) {
    if (!("__guide" in global_variable)) global_variable.__guide = new Map();
    let outputArray = [];
    for (const inst of instruction) {
      if (!(inst.startsWith('{') && inst.endsWith('}'))) {
        outputArray.push(inst);
        continue;
      }
      const trimmedInst = inst.slice(1, -1).trim();
      const displayKey = funcName ? `${funcName}::${trimmedInst}` : trimmedInst;
      const expressions = store.get("expressions");

      const indexMatch = trimmedInst.match(/^([^\[\]]+)\[([^\[\]]+)\]$/);
      let baseContainer = null;
      let indexExpr = null;
      let idxDisplayKey = null;
      if (indexMatch) {
        baseContainer = indexMatch[1].trim();
        indexExpr = indexMatch[2].trim();

        if (/^\d+$/.test(indexExpr)) {
          if (!global_variable.__container_highlights) global_variable.__container_highlights = new Map();
          if (!global_variable.__container_highlights.has(frame_line)) global_variable.__container_highlights.set(frame_line, {});

          const baseContainerKey = funcName ? `${funcName}::${baseContainer}` : baseContainer;
          global_variable.__container_highlights.get(frame_line)[baseContainerKey] = parseInt(indexExpr);
          if (!global_variable.__latest_highlights) global_variable.__latest_highlights = new Map();
          global_variable.__latest_highlights.set(baseContainerKey, parseInt(indexExpr));
          indexExpr = null;
        } else {
          idxDisplayKey = funcName ? `${funcName}::${indexExpr}` : indexExpr;
          const existingIdxVar = expressions.find(obj => obj.expression === idxDisplayKey && obj.in_scope === "true");
          if (existingIdxVar) {
            GdbVariable.delete_gdb_variable(existingIdxVar.name);
          }
          GdbVariable.create_variable(indexExpr, "expr", idxDisplayKey);
        }
      }

      const existingVar = expressions.find(obj => obj.expression === displayKey && obj.in_scope === "true");
      if (existingVar) {
        // 如果已存在，先刪除以確保獲取最新值
        GdbVariable.delete_gdb_variable(existingVar.name);
      }
      // 總是創建新的變數對象以獲取最新值
      GdbVariable.create_variable(trimmedInst, "expr", displayKey);

      if (!global_variable.__active_visualizer_exprs) {
        global_variable.__active_visualizer_exprs = new Set();
      }
      global_variable.__active_visualizer_exprs.add(displayKey);

      const addrExpr = `&(${trimmedInst})`;
      const addrDisplayKey = `&(${displayKey})`;
      const existingAddrVar = expressions.find(obj => obj.expression === addrDisplayKey && obj.in_scope === "true");
      if (existingAddrVar) {
        GdbVariable.delete_gdb_variable(existingAddrVar.name);
      }
      GdbVariable.create_variable(addrExpr, "expr", addrDisplayKey);

      // 等待並獲取結果
      const result = await new Promise((resolve) => {
        let checkTicks = 0;
        const checkStore = () => {
          checkTicks++;
          if (checkTicks > 50) {
            console.warn(`[VisualizerHelper] Promise TIMEOUT for expression: ${trimmedInst}`);
            resolve(trimmedInst);
            return;
          }
          const expressions = store.get("expressions");

          let highlightIndexReady = true;
          if (indexExpr) {
            const idxObj = expressions.find(obj => obj.expression === idxDisplayKey && obj.in_scope === "true");
            if (!idxObj || idxObj.value === undefined) {
              highlightIndexReady = false;
            } else {
              const parsedIdx = parseInt(idxObj.value);
              if (!isNaN(parsedIdx)) {
                if (!global_variable.__container_highlights) global_variable.__container_highlights = new Map();
                if (!global_variable.__container_highlights.has(frame_line)) global_variable.__container_highlights.set(frame_line, {});
                const baseContainerKey = funcName ? `${funcName}::${baseContainer}` : baseContainer;
                global_variable.__container_highlights.get(frame_line)[baseContainerKey] = parsedIdx;
                if (!global_variable.__latest_highlights) global_variable.__latest_highlights = new Map();
                global_variable.__latest_highlights.set(baseContainerKey, parsedIdx);
              }
              indexExpr = null;
            }
          }

          const varObj = expressions.find(obj => obj.expression === displayKey && obj.in_scope === "true");
          if (varObj && highlightIndexReady) {
            console.log(`[VisualizerHelper] Found variable: ${displayKey}, numchild: ${varObj.numchild}, value: ${varObj.value}`);

            // ── 判斷容器類型 ──
            const ty = varObj.type || "";
            let containerName = "unknown";
            let expectsCapacity = false;
            if (ty.includes("std::stack")) containerName = "stack";
            else if (ty.includes("std::queue") || ty.includes("std::priority_queue")) containerName = "queue";
            else if (ty.includes("std::deque")) containerName = "deque";
            else if (ty.includes("std::vector")) { containerName = "vector"; expectsCapacity = true; }
            else if (ty.includes("std::__cxx11::basic_string") || ty.includes("std::string")) { containerName = "string"; }
            else if (ty.includes("std::__cxx11::list") || ty.includes("std::list")) containerName = "list";
            else if (ty.includes("std::array")) containerName = "array";
            else if (ty.includes("std::set") || ty.includes("std::multiset")) containerName = "set";
            else if (ty.includes("std::map") || ty.includes("std::multimap")) containerName = "map";

            // ── 建立 payload 函數 ──
            const buildPayload = (valuesArr) => {
              const payload = { name: displayKey, type: containerName, values: valuesArr, isContainer: true };
              return payload;
            };

            if (containerName === "unknown") {
              resolve(varObj.value);
            } else if (containerName === "string") {
              let strVal = varObj.value || "";
              if (strVal.startsWith('"') && strVal.endsWith('"')) strVal = strVal.slice(1, -1);
              const payload = buildPayload(strVal.split(''));
              // 寫入 containers_guide
              if (!global_variable.__containers_guide) global_variable.__containers_guide = new Map();
              if (!global_variable.__containers_guide.has(frame_line)) global_variable.__containers_guide.set(frame_line, []);
              global_variable.__containers_guide.get(frame_line).push(payload);
              if (!global_variable.__latest_containers) global_variable.__latest_containers = new Map();
              global_variable.__latest_containers.set(displayKey, payload);
              resolve(`{${strVal}}`);
            } else if ((varObj.value || "").includes("of length 0") ||
              (varObj.numchild === 0 && !(varObj.value || "").match(/(length|size)\s+[1-9]/i))) {
              // 空容器
              const payload = buildPayload([]);
              if (!global_variable.__containers_guide) global_variable.__containers_guide = new Map();
              if (!global_variable.__containers_guide.has(frame_line)) global_variable.__containers_guide.set(frame_line, []);
              global_variable.__containers_guide.get(frame_line).push(payload);
              if (!global_variable.__latest_containers) global_variable.__latest_containers = new Map();
              global_variable.__latest_containers.set(displayKey, payload);
              resolve("{}");
            } else if (varObj.numchild > 0) {
              if (varObj.children && varObj.children.length > 0) {
                const childValues = varObj.children.map(child => child.value);
                const payload = buildPayload(childValues);

                // 嘗試抓 capacity（非阻塞）
                if (expectsCapacity) {
                  const capExpr = `${trimmedInst}.capacity()`;
                  const capObj = expressions.find(obj => obj.expression === capExpr);
                  if (capObj && capObj.value !== undefined) {
                    const parsedCap = parseInt(capObj.value);
                    if (!isNaN(parsedCap)) payload.capacity = parsedCap;
                  } else {
                    // 建立 capacity 查詢（非阻塞，下次會拿到）
                    if (!global_variable.__asking_capacity_for) global_variable.__asking_capacity_for = new Set();
                    if (!global_variable.__asking_capacity_for.has(capExpr)) {
                      global_variable.__asking_capacity_for.add(capExpr);
                      GdbVariable.create_variable(capExpr, "watch");
                    }
                  }
                }

                // 寫入 containers_guide
                if (!global_variable.__containers_guide) global_variable.__containers_guide = new Map();
                if (!global_variable.__containers_guide.has(frame_line)) global_variable.__containers_guide.set(frame_line, []);
                global_variable.__containers_guide.get(frame_line).push(payload);
                if (!global_variable.__latest_containers) global_variable.__latest_containers = new Map();
                global_variable.__latest_containers.set(displayKey, payload);

                const valStr = childValues.join(', ');
                resolve(`{${valStr}}`);
              } else {
                // children 未載入，繼續等待
                GdbVariable.fetch_and_show_children_for_var(varObj.name);
                setTimeout(checkStore, 100);
              }
            } else {
              resolve(varObj.value);
            }
          } else {
            if (!global_variable._debug_counter) global_variable._debug_counter = 0;
            global_variable._debug_counter++;
            if (global_variable._debug_counter % 10 === 0) {
              const exprs = expressions.map(e => `"${e.expression}"`).join(', ');
              console.log(`[VisualizerHelper] Waiting for variable "${displayKey}" or index "${idxDisplayKey}"... Available expressions: [${exprs}]`);
            }
            setTimeout(checkStore, 100);
          }
        };
        checkStore();
        console.log(`總有跑checkStore了吧`);
      });
      console.log(`單獨結果 for ${displayKey}: ${result}`);
      outputArray.push(result);
    }
    const outputString = outputArray.join('');
    // 將字面上的 \n 替換為實際的換行符 \n
    const processedString = outputString.replace(/\\n/g, '\n');
    //若該行指導還沒建立，先建立
    if (!(global_variable.__guide.has(frame_line))) global_variable.__guide.set(frame_line, []);

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