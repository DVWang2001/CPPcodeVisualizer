import { global_variable } from "./global_variable";
import { store } from "statorgfc";
import GdbVariable from "./GdbVariable";
import GdbApi from "./GdbApi";

// ── TTS 播放狀態（模組級）────────────────────────────────────────────
let _tts_task_id = 0;           // 每次 play_tts 遞增，舊任務比對不符就自動放棄
let _tts_current_audio = null;  // 目前播放中的 Audio 元素，供中斷使用

// ── 多段與停頓播放清單狀態（模組級）──
let _tts_playlist = null;       // 播放清單陣列，例如 [{type: 'audio', text: '...', url: '...', currentTime: 0}, {type: 'wait', duration: 1.5}]
let _tts_playlist_index = 0;    // 目前消耗的清單索引
let _tts_wait_timeout = null;   // 停頓中使用的計時器 ID
let _tts_wait_start_time = 0;   // wait 項目開始等待的 timestamp (ms)
let _tts_autoplay_command = null; // 清單結束後要執行的自動播放指令
let _tts_subtitle_text = "";    // 去除所有標記後的純淨字幕文字

// ── graphics_instruction 取消 token（模組級）──────────────────────────
let _graphics_task_id = 0;      // 每次 graphics_instruction 遞增，舊任務自動放棄

/** 停止目前播放的音訊與停頓計時器。 */
function _tts_cancel() {
  if (_tts_current_audio) {
    _tts_current_audio.pause();
    _tts_current_audio.src = '';
    _tts_current_audio = null;
  }
  if (_tts_wait_timeout) {
    clearTimeout(_tts_wait_timeout);
    _tts_wait_timeout = null;
  }
  _tts_playlist = null;
  _tts_playlist_index = 0;
  _tts_autoplay_command = null;
}

/** 暫停目前播放的音訊或等待，動態記錄進度並回傳恢復所需的資訊。 */
function _tts_pause() {
  // 若沒有任何播放清單、音訊或等待中的任務，回傳 null 讓系統不再設定 resume 狀態
  if (!_tts_playlist && !_tts_current_audio && !_tts_wait_timeout) return null;

  let url = 'playlist-resume';
  let currentTime = 0;

  if (_tts_current_audio && !_tts_current_audio.paused) {
    url = _tts_current_audio.src;
    currentTime = _tts_current_audio.currentTime;
    _tts_current_audio.pause();
    // 儲存當前 audio 的中斷時間點
    if (_tts_playlist && _tts_playlist[_tts_playlist_index]) {
      _tts_playlist[_tts_playlist_index].currentTime = currentTime;
    }
  } else if (_tts_wait_timeout) {
    clearTimeout(_tts_wait_timeout);
    _tts_wait_timeout = null;
    // 計算已經度過的秒數，動態更新剩餘所需等待的 duration
    const elapsed = (Date.now() - _tts_wait_start_time) / 1000;
    if (_tts_playlist && _tts_playlist[_tts_playlist_index]) {
      const currentWait = _tts_playlist[_tts_playlist_index];
      currentWait.duration = Math.max(0.01, currentWait.duration - elapsed);
    }
  }

  // 確保播放狀態的保留供 UI 與控制列識別
  const playing = window._gdbgui_tts_playing;
  if (playing) {
    playing.subtitleText = _tts_subtitle_text;
  }

  return { url, currentTime };
}

/** 從保留的清單狀態繼續接軌朗讀或等待。 */
function _tts_resume(_resumeInfo, _autoplayCommand) {
  if (!_tts_playlist) return;
  const currentTaskId = _tts_task_id;
  // 恢復全域識別變數
  window._gdbgui_tts_playing = {
    fullText: _tts_subtitle_text,
    subtitleText: _tts_subtitle_text,
    autoplayCommand: _tts_autoplay_command,
    lastCharIndex: 0,
  };
  _tts_play_next(currentTaskId);
}

/** 核心非同步遞迴清單消耗器：依序處理清單內的音訊播放與精確秒數延遲。 */
function _tts_play_next(taskId) {
  if (taskId !== _tts_task_id) return;

  // 清單播放完畢時，執行自動播放指令並釋放狀態
  if (!_tts_playlist || _tts_playlist_index >= _tts_playlist.length) {
    _tts_current_audio = null;
    _tts_wait_timeout = null;
    _tts_playlist = null;
    window._gdbgui_tts_playing = null;
    window._gdbgui_tts_resume = null;
    if (typeof window.gdbgui_on_tts_end === 'function') window.gdbgui_on_tts_end();
    if (_tts_autoplay_command && typeof window.gdbgui_execute_autoplay_command === 'function') {
      window.gdbgui_execute_autoplay_command(_tts_autoplay_command);
    }
    return;
  }

  const item = _tts_playlist[_tts_playlist_index];

  if (item.type === 'wait') {
    _tts_current_audio = null;
    _tts_wait_start_time = Date.now();
    const ms = item.duration * 1000;
    console.log(`[TTS] Pausing for ${item.duration}s...`);
    _tts_wait_timeout = setTimeout(() => {
      _tts_wait_timeout = null;
      if (taskId !== _tts_task_id) return;
      _tts_playlist_index++;
      _tts_play_next(taskId);
    }, ms);
  } else if (item.type === 'audio') {
    const audio = new Audio();
    _tts_current_audio = audio;

    const finish = () => {
      if (_tts_current_audio === audio) _tts_current_audio = null;
      if (taskId !== _tts_task_id) return;
      _tts_playlist_index++;
      _tts_play_next(taskId);
    };

    audio.onended = finish;
    audio.onerror = () => { console.warn('[TTS] Segment playback error'); finish(); };

    let canplayFired = false;
    const watchdog = setTimeout(() => {
      if (!canplayFired && _tts_current_audio === audio && taskId === _tts_task_id) {
        audio.playbackRate = (store.get('tts_speed')) || 1.0;
        audio.play().catch(() => finish());
      }
    }, 5000);

    audio.addEventListener('canplay', () => {
      canplayFired = true;
      clearTimeout(watchdog);
      if (_tts_current_audio !== audio || taskId !== _tts_task_id) return;
      audio.playbackRate = (store.get('tts_speed')) || 1.0;
      if (item.currentTime) {
        audio.currentTime = item.currentTime;
        item.currentTime = 0;
      }
      audio.play().catch(() => finish());
    }, { once: true });

    audio.src = item.url;
    audio.load();
  }
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

    // --- 攔截 [speed:N] 語法，設定 TTS 播放速度 ---
    const speedRegex = /\[speed:([\d.]+)\]/g;
    let speedMatch;
    while ((speedMatch = speedRegex.exec(guideContent)) !== null) {
      const speed = parseFloat(speedMatch[1]);
      if (!isNaN(speed) && speed >= 0.1 && speed <= 4.0) {
        store.set('tts_speed', speed);
        // 若目前有正在播放的音訊，立即套用新速度
        const currentAudio = window._tts_api && window._tts_api._current();
        if (currentAudio) currentAudio.playbackRate = speed;
      }
    }
    // 移除 [speed:N] token，後續不顯示在 guide 面板
    const guideContentNoSpeed = guideContent.replace(speedRegex, '').trim();

    // --- 攔截 [自訂標籤#顏色] 語法給 Call Graph 使用 ---
    // 支援 `[標籤名稱#顏色] {變數}` 或是 `[標籤名稱] {變數}`
    const labelRegex = /^\[([^\]#]+)(?:#([^\]]+))?\]([\s\S]*)/;
    const labelMatch = guideContentNoSpeed.match(labelRegex);
    
    if (!global_variable.__call_graph_custom_labels) {
      global_variable.__call_graph_custom_labels = {};
    }

    let graphicsContent = guideContentNoSpeed;
    if (labelMatch) {
      const labelName = labelMatch[1].trim();
      const color = labelMatch[2] ? labelMatch[2].trim() : null; // 可選的顏色
      const remainingContent = labelMatch[3].trim();

      // 提取括號外 (remainingContent) 的 {變數}
      const outVars = VisualizerHelper.extractBalancedBraces(remainingContent)
        .filter(v => v.startsWith('{') && v.endsWith('}'))
        .map(v => v.slice(1, -1).trim());

      // 提取括號內 (labelName) 的 {變數}，例如 [啟動遞迴 n={n}] 中的 n
      const inLabelVars = VisualizerHelper.extractBalancedBraces(labelName)
        .filter(v => v.startsWith('{') && v.endsWith('}'))
        .map(v => v.slice(1, -1).trim());

      const varsToWatch = [...new Set([...outVars, ...inLabelVars])];

      global_variable.__call_graph_custom_labels[lineNum] = {
        labelName,
        color,
        vars: varsToWatch, // 變數名稱清單，稍後在 CallGraph 中取得其值
        originalLine: lineNum
      };

      // 將括號內的變數也傳給 graphics_instruction，確保 GDB varobj 被建立
      const inLabelContent = inLabelVars.map(v => `{${v}}`).join(' ');
      graphicsContent = [remainingContent, inLabelContent].filter(s => s).join(' ');
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
    
    // 套用 [speed:N] 設定（TTS 欄位自己設定的速度）
    const speedTagRegex = /\[speed:([\d.]+)\]/g;
    let speedTagMatch;
    while ((speedTagMatch = speedTagRegex.exec(rawTtsContent)) !== null) {
      const speed = parseFloat(speedTagMatch[1]);
      if (!isNaN(speed) && speed >= 0.1 && speed <= 4.0) {
        store.set('tts_speed', speed);
      }
    }

    // 先從原始完整字串嘗試抓取全域指令（先移除 [speed:N] 避免它擋在前面）
    const rawStripped = rawTtsContent.replace(/\[speed:[\d.]+\]/g, '').trimStart();
    const globalCmdMatch = rawStripped.match(/^\[(next|step-in|step-out|continue)\]\s*/);
    const globalAutoplayCommand = globalCmdMatch ? globalCmdMatch[1] : null;

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

    // 解析自動播放指令前綴：先移除 [speed:N]，再抓 [next]/[continue] 等
    const ttsContentNoSpeed = ttsContent.replace(/\[speed:[\d.]+\]/g, '').trimStart();
    const cmdMatch = ttsContentNoSpeed.match(/^\[(next|step-in|step-out|continue)\]\s*/);
    const autoplayCommand = cmdMatch ? cmdMatch[1] : globalAutoplayCommand;
    // 去除所有控制標籤（[speed:N] 及任意數量的指令標籤）得到純說話文字
    const ttsText = ttsContentNoSpeed
      .replace(/^\s*(\[(next|step-in|step-out|continue)\]\s*)*/,'')
      .trim();

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

    // 變數替換完成後確認任務是否仍有效（非同步查詢期間可能有新任務進來）
    if (myTaskId !== _tts_task_id) return;

    // 產生全局字幕文字：去除所有 [wait:X]、[pause:X] 以及讀音標記 [音]
    const displayText = evaluateSpokenText
      .replace(/\[(?:wait|pause):[\d.]+\]/g, '')
      .replace(/\[([^\[\]]+)\]/g, '')
      .trim();

    _tts_subtitle_text = displayText;
    _tts_autoplay_command = autoplayCommand;

    // 使用 Regex 分割字串，同時捕獲停頓標籤指定的秒數
    // 例如字串被分割成 ["語音段1", "1.5", "語音段2", "0.5", "語音段3"]
    const parts = evaluateSpokenText.split(/\[(?:wait|pause):([\d.]+)\]/g);
    const playlist = [];

    for (let i = 0; i < parts.length; i++) {
      if (i % 2 === 0) {
        // 語音文字段落
        const segText = parts[i];
        // 處理自定義發音 "字[音]"：替換讀音（白[柏] → 柏），讓 TTS 讀對
        const regexPronounce = /([^\[\]]+)\[([^\[\]]+)\]/g;
        const spokenSegText = segText.replace(regexPronounce, (_match, prefix, pronunciation) => {
          return prefix.slice(0, -1) + pronunciation;
        });
        if (spokenSegText.trim()) {
          const url = `/tts_audio?text=${encodeURIComponent(spokenSegText.trim())}`;
          playlist.push({ type: 'audio', text: spokenSegText.trim(), url: url, currentTime: 0 });
        }
      } else {
        // 停頓秒數
        const duration = parseFloat(parts[i]);
        if (!isNaN(duration) && duration > 0) {
          playlist.push({ type: 'wait', duration: duration });
        }
      }
    }

    // 若清單為空（如純 [continue] 指令或全空白），直接執行 autoplayCommand，跳過 TTS 播放
    if (playlist.length === 0) {
      window._gdbgui_tts_playing = null;
      window._gdbgui_tts_resume = null;
      if (typeof window.gdbgui_on_tts_end === 'function') window.gdbgui_on_tts_end();
      if (autoplayCommand && typeof window.gdbgui_execute_autoplay_command === 'function') {
        window.gdbgui_execute_autoplay_command(autoplayCommand);
      }
      return;
    }

    // 設定全局清單狀態
    _tts_playlist = playlist;
    _tts_playlist_index = 0;

    // 先顯示字幕，再啟動清單消耗器
    store.set("tts_subtitle", {
      text: displayText,
      line: parseInt(frame_line),
      timestamp: Date.now()
    });

    window._gdbgui_tts_playing = {
      fullText: displayText,
      subtitleText: displayText,
      autoplayCommand: autoplayCommand,
      lastCharIndex: 0
    };

    // 啟動播放
    _tts_play_next(myTaskId);
  }

  static async graphics_instruction(instruction, frame_line, funcName) {
    const myGraphicsTaskId = ++_graphics_task_id; // 新任務 ID，舊任務自動放棄
    // 清空前一個任務遺留的所有 VarCreator / ChildVarFetcher 佇列，
    // 讓新任務的 varobj 建立和子節點抓取能立即排在最前面
    GdbVariable.clear_visualizer_queues();
    if (!("__guide" in global_variable)) global_variable.__guide = new Map();
    // 所有 {expr} token 同時送出並行處理（Promise.all），
    // 避免因 {maze} 抓取 11 個子列時間過長，導致 TTS 結束後 autoplay 觸發
    // 新的 graphics_instruction，取消仍在等待中的 {q} 等後續 token。

    // 預先掃描本次 instruction 中所有帶索引的容器，將其高亮陣列清空，
    // 確保 {arr[i]} 與 {arr[j]} 能各自疊加，且不殘留上一步驟的高亮。
    if (!global_variable.__latest_highlights) global_variable.__latest_highlights = new Map();
    for (const _inst of instruction) {
      if (!(_inst.startsWith('{') && _inst.endsWith('}'))) continue;
      const _t = _inst.slice(1, -1).trim();
      const _m2D = _t.match(/^([^\[\]]+)\[([^\[\]]+)\]\[([^\[\]]+)\](?::(.+))?$/);
      const _m1D = !_m2D && _t.match(/^([^\[\]]+)\[([^\[\]]+)\](?::(.+))?$/);
      const _cName = _m2D ? _m2D[1].trim() : (_m1D ? _m1D[1].trim() : null);
      if (_cName) global_variable.__latest_highlights.set(_cName, []);
    }

    const outputArray = await Promise.all(instruction.map((inst) => {
      if (!(inst.startsWith('{') && inst.endsWith('}'))) {
        return Promise.resolve(inst);
      }
      const trimmedInst = inst.slice(1, -1).trim();
      // 若 trimmedInst 已經指定了明確的 scope (包含 ::)，則不再重複添加 funcName 前綴
      let displayKey = (funcName && trimmedInst.indexOf('::') === -1) ? `${funcName}::${trimmedInst}` : trimmedInst;
      const expressions = store.get("expressions");

      const indexMatch2D = trimmedInst.match(/^([^\[\]]+)\[([^\[\]]+)\]\[([^\[\]]+)\](?::(.+))?$/);
      const indexMatch = trimmedInst.match(/^([^\[\]]+)\[([^\[\]]+)\](?::(.+))?$/);
      let baseContainer = null;
      let indexExpr = null;
      let idxDisplayKey = null;

      let rowExpr = null;
      let colExpr = null;
      let rowDisplayKey = null;
      let colDisplayKey = null;
      let highlightColor = 'default'; // 'default'=黃色，或任意 CSS 色碼字串

      if (indexMatch2D) {
        baseContainer = indexMatch2D[1].trim();
        rowExpr = indexMatch2D[2].trim();
        colExpr = indexMatch2D[3].trim();
        if (indexMatch2D[4]) highlightColor = indexMatch2D[4].trim();

        if (/^\d+$/.test(rowExpr)) {
          // static
        } else {
          rowDisplayKey = funcName ? `${funcName}::${rowExpr}` : rowExpr;
          const existingRowVar = expressions.find(obj => obj.expression === rowDisplayKey && obj.in_scope === "true");
          if (existingRowVar) GdbVariable.delete_gdb_variable(existingRowVar.name);
          GdbVariable.create_variable(rowExpr, "expr", rowDisplayKey);
        }

        if (/^\d+$/.test(colExpr)) {
          // static
        } else {
          colDisplayKey = funcName ? `${funcName}::${colExpr}` : colExpr;
          const existingColVar = expressions.find(obj => obj.expression === colDisplayKey && obj.in_scope === "true");
          if (existingColVar) GdbVariable.delete_gdb_variable(existingColVar.name);
          GdbVariable.create_variable(colExpr, "expr", colDisplayKey);
        }
      } else if (indexMatch) {
        baseContainer = indexMatch[1].trim();
        indexExpr = indexMatch[2].trim();
        if (indexMatch[3]) highlightColor = indexMatch[3].trim();

        if (/^\d+$/.test(indexExpr)) {
          if (!global_variable.__container_highlights) global_variable.__container_highlights = new Map();
          if (!global_variable.__container_highlights.has(frame_line)) global_variable.__container_highlights.set(frame_line, {});

          const baseContainerKey = baseContainer;
          global_variable.__container_highlights.get(frame_line)[baseContainerKey] = parseInt(indexExpr);
          if (!global_variable.__latest_highlights) global_variable.__latest_highlights = new Map();
          const hl0 = global_variable.__latest_highlights.get(baseContainerKey) || [];
          hl0.push({ index: parseInt(indexExpr), color: highlightColor });
          global_variable.__latest_highlights.set(baseContainerKey, hl0);
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

      // {arr[i]} / {arr[i][j]}：用 BASE CONTAINER 建立 varobj 而非元素值，
      // 這樣才能得到完整的容器視覺化並套用 highlight；否則只會拿到 int 類型。
      if (baseContainer && (indexMatch || indexMatch2D)) {
        trimmedInst = baseContainer;
        displayKey = (funcName && baseContainer.indexOf('::') === -1) ? `${funcName}::${baseContainer}` : baseContainer;
      }

      // 若已有 in-scope 的 varobj（可能由其他函數 frame 建立，如 main::maze 在 solveMaze 中），
      // -var-update --all-values * 已自動更新其子節點值，直接複用即可，不需刪除重建。
      // 支援跨函數複用：trimmedInst 相同但 funcName 不同時（e.g. main::maze vs solveMaze::maze）
      // 仍能找到同一個 in-scope varobj。
      const existingInScopeVar = expressions.find(
        obj => obj.in_scope === "true" && (
          obj.expression === displayKey ||
          obj.expression === trimmedInst ||
          (trimmedInst.indexOf('::') === -1 && obj.expression.endsWith('::' + trimmedInst))
        )
      );
      if (existingInScopeVar) {
        // 複用現有 varobj；更新 displayKey 確保後續 checkStore 能找到它
        displayKey = existingInScopeVar.expression;
      } else {
        // 刪除所有同名舊 varobj（出 scope 的殘留）並建立新的
        expressions.filter(obj =>
          obj.expression === displayKey ||
          obj.expression === trimmedInst ||
          (trimmedInst.indexOf('::') === -1 && obj.expression.endsWith('::' + trimmedInst))
        ).forEach(v => GdbVariable.delete_gdb_variable(v.name));
        GdbVariable.create_variable(trimmedInst, "expr", displayKey);
      }

      if (!global_variable.__active_visualizer_exprs) {
        global_variable.__active_visualizer_exprs = new Set();
      }
      global_variable.__active_visualizer_exprs.add(displayKey);

      // 若複用現有 varobj，記錄目前的 changelist 版本號，
      // checkStore 必須等到版本號遞增（代表本次 stop 的 changelist 已處理完畢）再讀值。
      const capturedChangelistVersion = existingInScopeVar
        ? (window.__gdbgui_changelist_version || 0)
        : -1; // -1 表示不需要等待

      const addrExpr = `&(${trimmedInst})`;
      const addrDisplayKey = `&(${displayKey})`;
      const existingAddrVar = expressions.find(obj => obj.expression === addrDisplayKey && obj.in_scope === "true");
      if (existingAddrVar) {
        GdbVariable.delete_gdb_variable(existingAddrVar.name);
      }
      GdbVariable.create_variable(addrExpr, "expr", addrDisplayKey);

      // 等待並獲取結果（與其他 {expr} 並行）
      return new Promise((resolve) => {
        let checkTicks = 0;
        const checkStore = () => {
          // 若有更新的 graphics_instruction 任務，立即放棄（不寫入 __latest_containers）
          if (_graphics_task_id !== myGraphicsTaskId) {
            console.log(`[GI] task ${myGraphicsTaskId} cancelled for "${trimmedInst}" line=${frame_line}`);
            resolve(trimmedInst);
            return;
          }
          // 若複用已存在的 varobj，必須等到本次 stop 的 changelist 處理完畢（版本號遞增）再讀值，
          // 否則拿到的仍是上一個斷點的舊值。
          if (capturedChangelistVersion >= 0 &&
              (window.__gdbgui_changelist_version || 0) <= capturedChangelistVersion) {
            setTimeout(checkStore, 50);
            return;
          }
          checkTicks++;
          if (checkTicks > 150) {
            console.warn(`[GI] TIMEOUT task=${myGraphicsTaskId} "${trimmedInst}" line=${frame_line}`);
            resolve(trimmedInst);
            return;
          }
          const expressions = store.get("expressions");

          let highlightIndexReady = true;
          if (indexMatch2D && (rowExpr || colExpr)) {
            let rowVal = undefined;
            let colVal = undefined;

            if (rowExpr) {
              if (/^\d+$/.test(rowExpr)) {
                rowVal = parseInt(rowExpr);
              } else {
                const rowObj = expressions.find(obj => obj.expression === rowDisplayKey && obj.in_scope === "true");
                if (rowObj && rowObj.value !== undefined) rowVal = parseInt(rowObj.value);
              }
            } else {
              rowVal = 0;
            }

            if (colExpr) {
              if (/^\d+$/.test(colExpr)) {
                colVal = parseInt(colExpr);
              } else {
                const colObj = expressions.find(obj => obj.expression === colDisplayKey && obj.in_scope === "true");
                if (colObj && colObj.value !== undefined) colVal = parseInt(colObj.value);
              }
            } else {
              colVal = 0;
            }

            if (rowVal === undefined || colVal === undefined) {
              highlightIndexReady = false;
            } else {
              if (!isNaN(rowVal) && !isNaN(colVal)) {
                let cols = 1;
                const baseContainerKey = baseContainer;
                if (global_variable.__latest_containers && global_variable.__latest_containers.has(baseContainerKey)) {
                  const data = global_variable.__latest_containers.get(baseContainerKey);
                  if (data.values && data.values.length > 0 && Array.isArray(data.values[0])) {
                    cols = data.values[0].length;
                  }
                }
                const parsedIdx = rowVal * cols + colVal;
                if (!global_variable.__container_highlights) global_variable.__container_highlights = new Map();
                if (!global_variable.__container_highlights.has(frame_line)) global_variable.__container_highlights.set(frame_line, {});
                global_variable.__container_highlights.get(frame_line)[baseContainerKey] = parsedIdx;
                if (!global_variable.__latest_highlights) global_variable.__latest_highlights = new Map();
                const hl2D = global_variable.__latest_highlights.get(baseContainerKey) || [];
                hl2D.push({ index: parsedIdx, color: highlightColor });
                global_variable.__latest_highlights.set(baseContainerKey, hl2D);
              }
              rowExpr = null;
              colExpr = null;
            }
          } else if (indexExpr) {
            const idxObj = expressions.find(obj => obj.expression === idxDisplayKey && obj.in_scope === "true");
            if (!idxObj || idxObj.value === undefined) {
              highlightIndexReady = false;
            } else {
              const parsedIdx = parseInt(idxObj.value);
              if (!isNaN(parsedIdx)) {
                if (!global_variable.__container_highlights) global_variable.__container_highlights = new Map();
                if (!global_variable.__container_highlights.has(frame_line)) global_variable.__container_highlights.set(frame_line, {});
                const baseContainerKey = baseContainer;
                global_variable.__container_highlights.get(frame_line)[baseContainerKey] = parsedIdx;
                if (!global_variable.__latest_highlights) global_variable.__latest_highlights = new Map();
                const hl1D = global_variable.__latest_highlights.get(baseContainerKey) || [];
                hl1D.push({ index: parsedIdx, color: highlightColor });
                global_variable.__latest_highlights.set(baseContainerKey, hl1D);
              }
              indexExpr = null;
            }
          }

          const varObj = expressions.find(obj => obj.expression === displayKey && obj.in_scope === "true");
          if (varObj && highlightIndexReady) {

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
            else if (ty.includes("std::unordered_set") || ty.includes("std::unordered_multiset")) containerName = "set";
            else if (ty.includes("std::set") || ty.includes("std::multiset")) containerName = "set";
            else if (ty.includes("std::unordered_map") || ty.includes("std::unordered_multimap")) containerName = "unordered_map";
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
              global_variable.__latest_containers.set(trimmedInst, payload);
              resolve(`{${strVal}}`);
            } else if ((varObj.value || "").includes("of length 0") ||
              (varObj.numchild === 0 && !(varObj.value || "").match(/(length|size)\s+[1-9]/i))) {
              // 空容器
              const payload = buildPayload([]);
              if (!global_variable.__containers_guide) global_variable.__containers_guide = new Map();
              if (!global_variable.__containers_guide.has(frame_line)) global_variable.__containers_guide.set(frame_line, []);
              global_variable.__containers_guide.get(frame_line).push(payload);
              if (!global_variable.__latest_containers) global_variable.__latest_containers = new Map();
              global_variable.__latest_containers.set(trimmedInst, payload);
              console.log(`[GI] stored "${trimmedInst}" line=${frame_line} task=${myGraphicsTaskId} EMPTY`);
              resolve("{}");
            } else if (varObj.numchild > 0) {
              if (varObj.children && varObj.children.length > 0) {
                // 若有 child 本身是容器（value 含 "of length"），需要遞迴展開
                // 注意：GDB pretty-printer 回傳的 inner vector child.numchild 可能是 NaN，
                // 所以改用 child.value 字串偵測
                const isInnerContainer = (child) =>
                  typeof child.value === 'string' && child.value.includes('of length');
                const isEmptyInnerContainer = (child) =>
                  isInnerContainer(child) && /of length 0\b/.test(child.value || '');
                const hasInnerContainers = varObj.children.some(isInnerContainer);
                let childValues;
                if (hasInnerContainers) {
                  // 直接檢查 varObj.children[i].children（fetch 後會被 mutate 更新到 store）
                  // 空的內層容器（"of length 0"）不需要 fetch，直接視為空陣列
                  const innerMissing = varObj.children.filter(
                    child => isInnerContainer(child) &&
                             !isEmptyInnerContainer(child) &&
                             !(child.children && child.children.length > 0)
                  );
                  if (innerMissing.length > 0) {
                    // 逐一觸發展開（每次最多 5 個，避免 queue 塞滿）
                    // 注意：動態 varobj 的 numchild 可能是 NaN（因為用 has_more 而非 numchild）
                    // fetch_and_show_children_for_var 會檢查 obj.numchild，NaN 是 falsy 會跳過
                    // → 先從 child.value 解析長度寫回 numchild，再觸發 fetch
                    const exprs = store.get("expressions");
                    innerMissing.slice(0, 5).forEach(child => {
                      if (!child.numchild || isNaN(child.numchild)) {
                        const m = (child.value || '').match(/of length (\d+)/);
                        if (m) {
                          child.numchild = parseInt(m[1]);
                        } else {
                          child.numchild = 1; // fallback: 給 truthy 值讓 fetch 能進行
                        }
                      }
                    });
                    store.set("expressions", exprs);
                    innerMissing.slice(0, 5).forEach(child =>
                      GdbVariable.fetch_and_show_children_for_var(child.name)
                    );
                    setTimeout(checkStore, 200);
                    return;
                  }
                  // 所有內層均已展開，組成 nested array
                  childValues = varObj.children.map(child => {
                    if (isEmptyInnerContainer(child)) {
                      return [];  // 空的內層容器（如空 deque）直接給空陣列
                    }
                    if (isInnerContainer(child) && child.children && child.children.length > 0) {
                      return child.children.map(c => c.value);
                    }
                    return child.value;
                  });
                  // 對 queue/stack/deque 這類「單一內層容器包裝」類型做扁平化：
                  // 無 pretty-printer 時 std::queue 只有一個 _M_c (deque) 子層，
                  // 展開後為 [[elem0, elem1, ...]]，需攤平為 [elem0, elem1, ...]
                  if (['queue', 'stack', 'deque'].includes(containerName) &&
                      childValues.length === 1 && Array.isArray(childValues[0])) {
                    childValues = childValues[0];
                  }
                } else if (containerName === "map" || containerName === "unordered_map") {
                  // map 子節點是 {first = K, second = V} 結構，解析成 {key, value} 物件
                  childValues = varObj.children.map(child => {
                    const str = String(child.value || "").trim();
                    // GDB pretty-printer 格式: {first = K, second = V}
                    const firstIdx = str.indexOf('first = ');
                    const secondIdx = str.lastIndexOf(', second = ');
                    if (firstIdx !== -1 && secondIdx !== -1 && secondIdx > firstIdx) {
                      const key = str.slice(firstIdx + 8, secondIdx).trim();
                      const val = str.slice(secondIdx + 11).replace(/\s*\}$/, '').trim();
                      return { key, value: val };
                    }
                    // 無法解析時使用 child.expression 當 key、value 當 value
                    return { key: child.expression || String(varObj.children.indexOf(child)), value: str };
                  });
                } else {
                  childValues = varObj.children.map(child => child.value);
                }
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
                global_variable.__latest_containers.set(trimmedInst, payload);

                // Fetch RB-tree structure for ordered containers (values merged on frontend)
                if (containerName === "set" || containerName === "multiset" ||
                    containerName === "map" || containerName === "multimap") {
                  VisualizerHelper.fetchRBTreeData(trimmedInst);
                }

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
        // 立即開始輪詢；若需等 changelist，checkStore 內部的版本號偵測會自動 spin。
        setTimeout(checkStore, 0);
      });
    }));
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

  static fetchRBTreeData(varName) {
    // Read only tree STRUCTURE from GDB (color + left/right links via base class).
    // Values are NOT read here — the frontend merges them from the variable inspector
    // by matching in-order position (both are sorted, so they align 1:1).
    const safe = varName.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const pyLines = [
      'import gdb,json',
      'def _w(p,ha):',
      ' try:',
      '  a=int(p)',
      '  if a==0 or a==ha:return None',
      '  d=p.dereference()',
      '  c="R"if int(d["_M_color"])==0 else"B"',
      '  return{"c":c,"l":_w(d["_M_left"],ha),"r":_w(d["_M_right"],ha)}',
      ' except:return None',
      'try:',
      ' obj=gdb.parse_and_eval("' + safe + '")',
      ' tr=obj["_M_t"]',
      ' try:h=tr["_M_impl"]["_M_header"]',
      ' except:h=tr["_M_header"]',
      ' ha=int(h.address)',
      ' root=_w(h["_M_parent"],ha)',
      ' print("__GDBGUI_RBTREE__:"+json.dumps({"n":"' + safe + '","t":root}))',
      'except:pass',
    ];
    const script = pyLines.join('\n');
    const b64 = btoa(script);
    GdbApi.run_gdb_command(
      `-interpreter-exec console "python import base64; exec(base64.b64decode('${b64}').decode())"`
    );
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