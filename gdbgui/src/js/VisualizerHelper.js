import { global_variable } from "./global_variable";
import { store } from "statorgfc";
import GdbVariable from "./GdbVariable";
import GdbApi from "./GdbApi";
import FileOps from "./FileOps";
import { animScheduler } from "./AnimScheduler";
import { getPlugin } from "./ContainerPlugin";
import { bstPlugin } from "./BSTPlugin";
import { resolveChildValues } from "./containerParsers/index";
import { buildUmlPayload } from "./umlPayload";
import {
  parseFastDirective,
  stripFastDirective,
  isFastTargetExpr,
  fastTargetExpr,
  toFastTarget,
  decideFastState,
  getFastForward,
  armFastForward,
  disarmFastForward,
  FAST_FORWARD_STEP_LIMIT,
} from "./fastForward";

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
let _bst_op_task_id = 0;        // 每次 detect_container_op 遞增，舊任務自動放棄
const _uml_task_ids = {};       // 每個變數名各自的任務 ID 計數器（key=name），避免同一行多個 uml: 互相取消
const _uml_fetched_nodes = new Set(); // 已補抓 children 的節點 varobj 名稱，避免重複送 -var-list-children
// ── UML 遞迴展開參數（須與 umlPayload.ts 的 MAX_DEPTH/MAX_FANOUT 一致）──
const _UML_MAX_DEPTH = 4;
const _UML_MAX_FANOUT = 16;
function _uml_transparent(exp) {
  const n = (exp || "").trim();
  if (n === "public" || n === "private" || n === "protected") return true; // 存取分區
  if (n.startsWith("<")) return true; // <Animal> / <anonymous...>
  if (/[<:\s]/.test(n)) return true; // 模板/限定名的基底子物件 std::vector<Point,...>
  return false;
}
function _uml_intnc(node) {
  const n = typeof node.numchild === "string" ? parseInt(node.numchild) : node.numchild;
  if (!Number.isFinite(n) || n === 0) {
    // 動態 pretty-printer 容器（std::vector 等）的 numchild 可能是 NaN/0，
    // 但 value 會寫「of length N」——比照容器視覺化 InnerContainerParser 的做法用它補上，
    // 否則 vector 成員不會被判定為可展開、就不會補抓元素。
    const m = /of length (\d+)/.exec(node.value || "");
    if (m) return parseInt(m[1]);
  }
  return Number.isFinite(n) ? n : 0;
}
function _uml_is_pointer(node) {
  return !!node.type && String(node.type).trim().endsWith("*");
}
// 「可展開但 children 尚未載入」——不看是否已送出過抓取。這樣即使某節點的抓取還在飛行中，
// 輪詢也會持續（pending 仍非空），不會在抓取回來的前一個 tick 就提早組 payload（race 修正）。
function _uml_not_loaded(node) {
  return _uml_intnc(node) > 0 && (!node.children || node.children.length === 0);
}
// 走訪已載入的 varobj 子樹，收集「還沒完整展開（children 未載入）」的可展開節點（規則對齊 umlPayload.collect）
function _uml_gather_pending(children, depth, pending) {
  for (const c of children || []) {
    if (_uml_transparent(c.exp)) {
      if (_uml_not_loaded(c)) { pending.push(c); continue; }
      _uml_gather_pending(c.children, depth, pending); // 透明節點：同深度穿透
      continue;
    }
    const nc = _uml_intnc(c);
    const expandable = nc > 0 && !_uml_is_pointer(c) && depth < _UML_MAX_DEPTH && nc <= _UML_MAX_FANOUT;
    if (!expandable) continue; // 葉節點 / 指標 / 超過上限：不展開，不補抓
    if (_uml_not_loaded(c)) { pending.push(c); continue; }
    _uml_gather_pending(c.children, depth + 1, pending);
  }
}

// 程式重跑（inferior 重新開始）時清空 UML 狀態，否則面板會殘留上一次執行的物件框。
// 透過 window 橋接呼叫（避免 Actions ↔ VisualizerHelper 循環 import），比照 gdbgui_reset_var_queue。
// 清 _uml_task_ids 會讓在途輪詢（checkStore）下一個 tick 比對到 task id 不符而中止，
// 避免它在重跑後把舊 payload 又寫回新的 __latest_uml。
if (typeof window !== "undefined") {
  window.gdbgui_reset_uml_state = () => {
    for (const k in _uml_task_ids) delete _uml_task_ids[k];
    _uml_fetched_nodes.clear();
    global_variable.__latest_uml = new Map();
  };
}

// ── 容器解析結果快取（同一 GDB stop 內重複解析同容器時直接返回）──────────
let _gi_cache_version = -1;
const _gi_result_cache = new Map();

/**
 * Eagerly call diffOps + pushOps for a container whenever __latest_containers is updated.
 * Bypasses React's batched setState so every intermediate state triggers animation.
 */
function _eagerDiffOps(containerName, payload) {
  // 記錄「這個容器本次停駐的 payload 已經處理過」，供 detect_container_op 等待用。
  // 必須在任何提早 return 之前遞增，它代表的是「payload 到了」而非「有產生動畫」。
  if (!global_variable.__container_diff_seq) global_variable.__container_diff_seq = {};
  global_variable.__container_diff_seq[containerName] =
    (global_variable.__container_diff_seq[containerName] || 0) + 1;

  const plugin = getPlugin(payload.type);
  if (!plugin) return;
  // BST types need BST mode toggle to be on
  const bstTypes = new Set(['set', 'map', 'multiset', 'multimap']);
  if (bstTypes.has(payload.type)) {
    if (typeof window.gdbgui_is_bst_mode !== 'function') return;
    if (!window.gdbgui_is_bst_mode(containerName)) return;
  }
  const rr = () => window.gdbgui_request_render?.();
  const ops = plugin.diffOps(containerName, payload);
  if (ops.length > 0) {
    animScheduler.pushOps(containerName, ops, op => plugin.animateOp(containerName, op, rr));
  }
}

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

    // --- 攔截 uml:名稱 語法，建立 varobj 並產生 UML payload ---
    // 支援 `uml:name`（掃描全部出現次數），不進入 graphics_instruction / guide 面板顯示
    const umlRegex = /(?:^|\s)uml:([A-Za-z_][A-Za-z0-9_]*)/g;
    let umlMatch;
    while ((umlMatch = umlRegex.exec(guideContentNoSpeed)) !== null) {
      VisualizerHelper.processUml(umlMatch[1], funcName);
    }
    const guideNoUml = guideContentNoSpeed.replace(/(?:^|\s)uml:[A-Za-z_][A-Za-z0-9_]*/g, "").trim();

    // --- 攔截 [自訂標籤#顏色] 語法給 Call Graph 使用 ---
    // 支援 `[標籤名稱#顏色] {變數}` 或是 `[標籤名稱] {變數}`
    const labelRegex = /^\[([^\]#]+)(?:#([^\]]+))?\]([\s\S]*)/;
    const labelMatch = guideNoUml.match(labelRegex);

    if (!global_variable.__call_graph_custom_labels) {
      global_variable.__call_graph_custom_labels = {};
    }

    let graphicsContent = guideNoUml;
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

  /**
   * 向 GDB 求一個 TTS 運算式的值（`{變數}` 的共用實作）。
   * 逾時（5 秒）回傳運算式本身——呼叫端如果是唸出來就唸變數名，
   * 如果是 `[fast @{n}]` 求目標次數，則會因為不是正整數而不武裝。
   */
  static async _eval_tts_expression(expr, funcName) {
    // 使用 tts:: 前綴，避免與 graphics_instruction 的變數抓取產生 Race Condition
    const displayKey = funcName ? `tts::${funcName}::${expr}` : `tts::${expr}`;

    const expressions = store.get("expressions");
    const existingVar = expressions.find(obj => obj.expression === displayKey && obj.in_scope === "true");
    if (existingVar) {
      GdbVariable.delete_gdb_variable(existingVar.name);
    }
    GdbVariable.create_variable(expr, "expr", displayKey);

    // 非同步輪詢獲取結果
    return await new Promise((resolve) => {
      let checkTicks = 0;
      const checkStore = () => {
        checkTicks++;
        if (checkTicks > 50) {
          console.warn(`[VisualizerHelper] play_tts TIMEOUT for expression: ${expr}`);
          resolve(expr); // 超時則發音原本的變數名
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
  }

  // ── 快轉模式 `[fast @N]` ────────────────────────────────────────────
  // 抑制是全域的：武裝之後每一個停駐點都靜音、零延遲、立刻步進，
  // 只有「停在武裝行且造訪次數達標」才解除。逐行步進照做，所以容器、
  // 呼叫圖、__line_visit_count 全部照常累積，落地時狀態是對的。

  /** 目前這一行的造訪次數（inferior_program_paused 已經加過 1）。 */
  static _visit_count(lineNum) {
    const counts = global_variable.__line_visit_count;
    return (counts && counts[lineNum]) || 0;
  }

  /**
   * 已武裝時處理這一次停駐。
   * 回傳 true 代表「本次停駐已被快轉吃掉」——呼叫端要立刻 return，不播 TTS、不動字幕。
   * 回傳 false 代表已解除（或本來就沒武裝），照常往下播這一行。
   */
  static _fast_forward_pause(lineNum) {
    const armed = getFastForward();
    if (!armed) return false;

    // 展示到一半關掉自動播放＝要中止快轉；不然畫面會停在無聲狀態沒人推進
    if (!store.get("autoplay_enabled")) {
      console.warn("[fast] 自動播放已關閉，解除快轉");
      disarmFastForward();
      return false;
    }

    const decision = decideFastState(lineNum, VisualizerHelper._visit_count(lineNum), armed);
    if (decision === "disarm") {
      if (armed.steps > FAST_FORWARD_STEP_LIMIT) {
        console.warn(`[fast] 已達 ${FAST_FORWARD_STEP_LIMIT} 步安全上限，強制解除快轉（第 ${armed.line} 行 @${armed.target} 可能永遠達不到）`);
      }
      disarmFastForward();
      return false; // 落地：這一行照常唸自己的 TTS，行為等同 [next]
    }

    // hold：靜音步進。不設字幕、不進 TTS 播放清單，直接排下一步。
    armed.steps++;
    if (typeof window.gdbgui_execute_autoplay_command === 'function') {
      window.gdbgui_execute_autoplay_command('next');
    }
    return true;
  }

  /**
   * 嘗試武裝快轉。回傳 true 代表已武裝並靜音步進（呼叫端要 return）。
   * 求值失敗一律不武裝、只留 console 警告——失敗模式是「沒快轉」而非「教案壞掉」。
   */
  static async _try_arm_fast_forward(lineNum, rawTarget, funcName) {
    // 只在自動播放模式生效：手動按下一步卻一口氣衝掉兩百步太突兀
    if (!store.get("autoplay_enabled")) return false;

    let target;
    if (isFastTargetExpr(rawTarget)) {
      // {變數} 只在武裝當下求值一次，之後固定不變
      const value = await VisualizerHelper._eval_tts_expression(fastTargetExpr(rawTarget), funcName);
      target = toFastTarget(value);
      if (target === null) {
        console.warn(`[fast] @${rawTarget} 求值為 "${value}"，不是正整數 → 不武裝，退回 [next]`);
        return false;
      }
    } else {
      target = toFastTarget(rawTarget);
      if (target === null) {
        console.warn(`[fast] @${rawTarget} 不是正整數 → 不武裝，退回 [next]`);
        return false;
      }
    }

    const visitCount = VisualizerHelper._visit_count(lineNum);
    if (decideFastState(lineNum, visitCount, null, target) !== "arm") {
      // 次數已達標（例如迴圈第二次進入同一個 [fast]）：不武裝，照常播放
      return false;
    }

    console.log(`[fast] 武裝：第 ${lineNum} 行，目標第 ${target} 次造訪（目前第 ${visitCount} 次）`);
    armFastForward(lineNum, target);
    // 武裝當下這一次停駐也算快轉的一步，同樣靜音步進
    return VisualizerHelper._fast_forward_pause(lineNum);
  }

  static async play_tts(frame_line, funcName) {
    const myTaskId = ++_tts_task_id; // 新任務 ID，舊任務將自動放棄
    _tts_cancel();                   // 立即停止目前播放的音訊
    console.log(`[play_tts] Called with frame_line: ${frame_line}, funcName: ${funcName}`);
    const lineNum = parseInt(frame_line);

    // ── 快轉模式優先處理 ────────────────────────────────────────
    // 必須放在所有 early return 之前：抑制是全域的，沒有 //@ 標註的行
    // （甚至沒有行號的停駐點）也得靜音步進，否則快轉會斷在半路沒人推進。
    if (VisualizerHelper._fast_forward_pause(lineNum)) return;

    if (isNaN(lineNum)) return;
    if (!('__tts' in global_variable)) {
      console.log(`[play_tts] __tts not found in global_variable`);
      return;
    }
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

    // ── 快轉指令 [fast @N]：只解析「被選中的那一段」──────────────
    // 武裝成功就靜音步進、這一次不播；未武裝（求值失敗、次數已達標、
    // 非自動播放）則退化成 [next]，教案照常播放。
    const fastDirective = parseFastDirective(ttsContentNoSpeed);
    if (fastDirective) {
      const armed = await VisualizerHelper._try_arm_fast_forward(lineNum, fastDirective.target, funcName);
      if (myTaskId !== _tts_task_id) return; // 求值期間有新的停駐進來
      if (armed) return;
    }

    const autoplayCommand = cmdMatch
      ? cmdMatch[1]
      : (fastDirective ? 'next' : globalAutoplayCommand);
    // 去除所有控制標籤（[speed:N]、[fast @N] 及任意數量的指令標籤）得到純說話文字
    const ttsText = stripFastDirective(ttsContentNoSpeed)
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
      const result = await VisualizerHelper._eval_tts_expression(trimmedInst, funcName);
      console.log(`[play_tts] Evaluated expression ${trimmedInst} -> ${result}`);
      // 收錄非同步查詢到的值；先把 [] 轉成 ⟦⟧ 避免被 TTS 控制標記 regex 吃掉
      outputArray.push(String(result).replace(/\[/g, '⟦').replace(/\]/g, '⟧'));
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
      .replace(/⟦/g, '[').replace(/⟧/g, ']')
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
        }).replace(/⟦/g, '[').replace(/⟧/g, ']');
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

  /**
   * 解析 `uml:name` 指令：建立 varobj、等待其欄位(children)載入完成後，
   * 組出 UmlPayload 寫入 global_variable.__latest_uml，供 UML 物件圖渲染使用。
   */
  static processUml(name, funcName) {
    const displayKey = (funcName && name.indexOf("::") === -1) ? `${funcName}::${name}` : name;
    // 任務 ID 以「變數名」為單位（非單一共用計數器），
    // 這樣同一行內 `uml:a uml:b` 兩個不同名稱的任務彼此不會互相取消對方的輪詢，
    // 只有重複解析「同一個」名稱時，較新的呼叫才會讓舊的輪詢自動放棄。
    _uml_task_ids[name] = (_uml_task_ids[name] || 0) + 1;
    const myUmlTaskId = _uml_task_ids[name];

    const expressions = store.get("expressions");
    const existing = expressions.find(o => o.expression === displayKey && o.in_scope === "true");
    if (existing) GdbVariable.delete_gdb_variable(existing.name);
    GdbVariable.create_variable(name, "expr", displayKey);

    // 非同步輪詢：等 varobj 出現，且其 children 已載入完成（比照 graphics_instruction 的 checkStore 模式）。
    // create_variable 內部會自動觸發第一層 children 抓取（GdbVariable.fetch_and_show_children_for_var），
    // 因此這裡只需等待 numchild===0（無子欄位）或 children.length>0（子欄位已抓回）即可視為就緒；
    // 只保留一次補發抓取的安全網（避免自動抓取因故未觸發時卡死輪詢）。
    let checkTicks = 0;
    let didTriggerChildFetch = false;
    const checkStore = () => {
      if (_uml_task_ids[name] !== myUmlTaskId) return; // 同名的更新呼叫已進來，放棄本次任務
      checkTicks++;
      if (checkTicks > 150) {
        // 放棄等待深層抓取，用目前已載入的子樹盡力渲染（避免整格空白）
        console.warn(`[VisualizerHelper] processUml TIMEOUT for "${name}" (displayKey=${displayKey}) — 渲染部分結果`);
        const vo = store.get("expressions").find(o => o.expression === displayKey && o.in_scope === "true");
        if (vo) {
          if (!global_variable.__latest_uml) global_variable.__latest_uml = new Map();
          global_variable.__latest_uml.set(name, buildUmlPayload(name, vo.type || "?", vo.children || []));
          if (typeof window.gdbgui_request_render === "function") window.gdbgui_request_render();
        }
        return;
      }
      const exprs = store.get("expressions");
      const varObj = exprs.find(o => o.expression === displayKey && o.in_scope === "true");
      if (!varObj) {
        setTimeout(checkStore, 50);
        return;
      }
      const childrenReady = !varObj.numchild || (varObj.children && varObj.children.length > 0);
      if (!childrenReady) {
        if (!didTriggerChildFetch) {
          didTriggerChildFetch = true;
          GdbVariable.fetch_and_show_children_for_var(varObj.name);
        }
        setTimeout(checkStore, 50);
        return;
      }

      // 遞迴補抓整棵子樹：C++ 欄位藏在 public/private/protected 底下、巢狀值物件與 vector 元素
      // 也各在更深層（見 GdbVariable.tsx:409）。逐層把還沒載入 children 的可展開節點補抓完，才組 payload。
      const _umlPending = [];
      _uml_gather_pending(varObj.children || [], 0, _umlPending);
      if (_umlPending.length > 0) {
        _umlPending.forEach(c => {
          if (!_uml_fetched_nodes.has(c.name)) { // 每個節點只送一次抓取；仍未載入者持續輪詢
            _uml_fetched_nodes.add(c.name);
            GdbVariable.fetch_and_show_children_for_var(c.name);
          }
        });
        setTimeout(checkStore, 50);
        return;
      }

      if (!global_variable.__latest_uml) global_variable.__latest_uml = new Map();
      global_variable.__latest_uml.set(name, buildUmlPayload(name, varObj.type || "?", varObj.children || []));
      if (typeof window.gdbgui_request_render === "function") window.gdbgui_request_render();
    };
    checkStore();
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
      let trimmedInst = inst.slice(1, -1).trim();
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

        if (/^-?\d+$/.test(indexExpr)) {
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
          // 版本號變動時清除舊快取，確保跨 stop 不復用舊值
          const _cv = window.__gdbgui_changelist_version || 0;
          if (_cv !== _gi_cache_version) { _gi_result_cache.clear(); _gi_cache_version = _cv; }
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
            // ── 快取命中：同一 stop 內重複解析同容器直接返回 ──
            const _ck = `${displayKey}:${frame_line}`;
            const _cr = _gi_result_cache.get(_ck);
            if (_cr) {
              if (!global_variable.__containers_guide) global_variable.__containers_guide = new Map();
              if (!global_variable.__containers_guide.has(frame_line)) global_variable.__containers_guide.set(frame_line, []);
              global_variable.__containers_guide.get(frame_line).push(_cr.payload);
              if (!global_variable.__latest_containers) global_variable.__latest_containers = new Map();
              global_variable.__latest_containers.set(trimmedInst, _cr.payload);
              resolve(_cr.outputStr);
              return;
            }
            // ── 判斷容器類型 ──
            const ty = varObj.type || "";
            let containerName = "unknown";
            let expectsCapacity = false;
            if (ty.includes("std::stack")) containerName = "stack";
            else if (ty.includes("std::queue") || ty.includes("std::priority_queue")) containerName = "queue";
            else if (ty.includes("std::deque")) containerName = "deque";
            else if (ty.includes("std::vector")) { containerName = "vector"; expectsCapacity = true; }
            else if (ty.includes("std::__cxx11::list") || ty.includes("std::list")) containerName = "list";
            else if (ty.includes("std::array")) containerName = "array";
            else if (ty.includes("std::unordered_set") || ty.includes("std::unordered_multiset")) containerName = "set";
            else if (ty.includes("std::set") || ty.includes("std::multiset")) containerName = "set";
            else if (ty.includes("std::unordered_map") || ty.includes("std::unordered_multimap")) containerName = "unordered_map";
            else if (ty.includes("std::map") || ty.includes("std::multimap")) containerName = "map";
            // string check MUST come after map/set: map<K,string> type contains "basic_string"
            else if (ty.includes("std::__cxx11::basic_string") || ty.includes("std::string")) { containerName = "string"; }

            // 動態 pretty-printer 的 set/map varobj 在容器從空長大之後，numchild 會停留在
            // 建立當下的 0（GDB 先更新 value 字串，子節點數要下一個 stop 才跟上），
            // 但 value 已經寫成「with N elements」。比照 _uml_intnc 對 vector「of length N」
            // 的補值做法用 value 修正，否則下方的空容器判定會把它誤判成 {}，
            // 樹要慢一個停駐點才出現。
            if (!parseInt(String(varObj.numchild))) {
              const _nc = /with (\d+) element/i.exec(varObj.value || "");
              if (_nc && parseInt(_nc[1]) > 0) varObj.numchild = parseInt(_nc[1]);
            }

            // ── 建立 payload 函數 ──
            const buildPayload = (valuesArr) => {
              const payload = { name: displayKey, type: containerName, values: valuesArr, isContainer: true };
              return payload;
            };

            if (containerName === "unknown") {
              resolve(varObj.value);
            } else if (containerName === "string") {
              const _strResult = resolveChildValues(containerName, varObj, { trimmedInst, expressions, GdbVariable });
              let strVal = varObj.value || "";
              if (strVal.startsWith('"') && strVal.endsWith('"')) strVal = strVal.slice(1, -1);
              const payload = buildPayload(_strResult.values);
              // 寫入 containers_guide
              if (!global_variable.__containers_guide) global_variable.__containers_guide = new Map();
              if (!global_variable.__containers_guide.has(frame_line)) global_variable.__containers_guide.set(frame_line, []);
              global_variable.__containers_guide.get(frame_line).push(payload);
              if (!global_variable.__latest_containers) global_variable.__latest_containers = new Map();
              global_variable.__latest_containers.set(trimmedInst, payload);
              _eagerDiffOps(trimmedInst, payload);
              _gi_result_cache.set(`${displayKey}:${frame_line}`, { payload, outputStr: `{${strVal}}` });
              resolve(`{${strVal}}`);
            } else if ((varObj.value || "").includes("of length 0") ||
              (varObj.numchild === 0 &&
               !(varObj.value || "").match(/(length|size)\s+[1-9]/i) &&
               !(varObj.value || "").match(/^\{[^}]/))) {
              // 空容器（numchild=0 且 value 沒有 "{elem..." 格式）
              const payload = buildPayload([]);
              if (!global_variable.__containers_guide) global_variable.__containers_guide = new Map();
              if (!global_variable.__containers_guide.has(frame_line)) global_variable.__containers_guide.set(frame_line, []);
              global_variable.__containers_guide.get(frame_line).push(payload);
              if (!global_variable.__latest_containers) global_variable.__latest_containers = new Map();
              global_variable.__latest_containers.set(trimmedInst, payload);
              _eagerDiffOps(trimmedInst, payload);
              console.log(`[GI] stored "${trimmedInst}" line=${frame_line} task=${myGraphicsTaskId} EMPTY`);
              _gi_result_cache.set(`${displayKey}:${frame_line}`, { payload, outputStr: "{}" });
              resolve("{}");
            } else if (varObj.numchild === 0 && (varObj.value || "").match(/^\{[^}]/)) {
              // GDB pretty-printer 把容器值直接放在 value 字串（如 stack 回傳 "{1, 2, 3}"）
              // numchild=0 但 value 有內容，直接解析
              const raw = (varObj.value || "").replace(/^\{/, "").replace(/\}$/, "").trim();
              const parsedValues = raw.length > 0 ? raw.split(",").map(s => s.trim()) : [];
              const payload = buildPayload(parsedValues);
              if (!global_variable.__containers_guide) global_variable.__containers_guide = new Map();
              if (!global_variable.__containers_guide.has(frame_line)) global_variable.__containers_guide.set(frame_line, []);
              global_variable.__containers_guide.get(frame_line).push(payload);
              if (!global_variable.__latest_containers) global_variable.__latest_containers = new Map();
              global_variable.__latest_containers.set(trimmedInst, payload);
              _eagerDiffOps(trimmedInst, payload);
              console.log(`[GI] stored "${trimmedInst}" line=${frame_line} task=${myGraphicsTaskId} FROM_VALUE parsed=${parsedValues.length}`);
              _gi_result_cache.set(`${displayKey}:${frame_line}`, { payload, outputStr: `{${parsedValues.join(', ')}}` });
              resolve(`{${parsedValues.join(', ')}}`);
            } else if (varObj.numchild > 0) {
              // 若 children 數量與 numchild/new_num_children 不符（push/pop 後），強制重新 fetch
              // new_num_children 是 dynamic varobj（pretty-printer）pop 後的正確新大小
              const _newNch = (varObj.new_num_children !== undefined)
                ? parseInt(String(varObj.new_num_children)) : NaN;
              const _expectedSize = (!isNaN(_newNch)) ? _newNch : varObj.numchild;
              // GDB changelist 對 dynamic varobj 可能不會更新個別子節點的值（只報告
              // parent 改變），因此每次 stop（changelist 版本更新）都必須重新 fetch
              // children，確保拿到最新值。用 _lastChildRefetchCV 避免同一 stop 重複 fetch。
              const _needRefetch = varObj.children &&
                (varObj.children.length !== _expectedSize ||
                 (varObj._lastChildRefetchCV || -1) < _cv);
              if (_needRefetch) {
                varObj._lastChildRefetchCV = _cv;
                varObj.children = [];
                if (varObj.numchild !== _expectedSize) varObj.numchild = _expectedSize;
                store.set("expressions", expressions);
                GdbVariable.fetch_and_show_children_for_var(varObj.name);
                setTimeout(checkStore, 200);
                return;
              }
              if (varObj.children && varObj.children.length > 0) {
                let childValues;
                {
                  const _r = resolveChildValues(containerName, varObj, {
                    trimmedInst, expressions, GdbVariable, containerName, store
                  });
                  if (!_r.done) {
                    setTimeout(checkStore, _r.retryMs ?? 150);
                    return;
                  }
                  childValues = _r.values;
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
                _eagerDiffOps(trimmedInst, payload);

                // Fetch RB-tree structure for ordered containers (values merged on frontend)
                if (containerName === "set" || containerName === "multiset" ||
                    containerName === "map" || containerName === "multimap") {
                  VisualizerHelper.fetchRBTreeData(trimmedInst);
                }

                const valStr = childValues.join(', ');
                _gi_result_cache.set(`${displayKey}:${frame_line}`, { payload, outputStr: `{${valStr}}` });
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

  /**
   * 前瞻偵測：當 GDB 在某行暫停時，掃描該行是否對有 plugin 的容器呼叫：
   *   (1) find / count / contains  → 比對路徑動畫 + 綠/紅結果
   *   (2) insert / emplace 於 set/map → 若 key 已存在，比對路徑 + 琥珀色「重複」提示
   * 必須在 inferior_program_paused 的早期同步部分呼叫，確保 barrier 在 TTS 結束前建立。
   */
  static detect_container_op(frame_line, funcName) {
    const myTaskId = ++_bst_op_task_id;

    // find / lower_bound 的結果標記刻意留在畫面上，直到程式推進到下一行才清掉，
    // 讓學生能一邊看指導文字一邊對照答案。這裡是每個停駐點都會經過的位置，
    // 必須放在所有提早 return 之前。
    bstPlugin.clearProspectiveMarks();
    window.gdbgui_request_render?.();

    const lineNum = parseInt(frame_line);
    if (isNaN(lineNum)) return;

    const fullname = store.get("fullname_to_render");
    if (!fullname) return;

    // 快取的檔案物件存的是 source_code_obj（1-indexed，key 為行號），不是 source_code_array
    // ——後者只是伺服器 AJAX 回應的欄位名，從未寫進快取。用 FileOps 既有的存取器，
    // 避免再次寫錯屬性名（先前讀 source_code_array[lineNum-1] 恆為 undefined，
    // 導致本函式整個靜默失效、find/lower_bound 的動畫從來沒觸發過）。
    const rawLineHtml = FileOps.get_line_from_file(fullname, lineNum);
    if (!rawLineHtml) return;

    const rawLine = String(rawLineHtml)
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"');

    // ── 輔助：非同步 eval key 表達式 ──────────────────────────────────────────
    const evalKey = async (keyExpr, displayKey) => {
      if (/^-?\d+$/.test(keyExpr)) return keyExpr;
      if (/^["'].+["']$/.test(keyExpr)) return keyExpr.replace(/^["'](.+)["']$/, '$1');
      const existing = store.get("expressions").find(obj => obj.expression === displayKey && obj.in_scope === "true");
      if (existing) GdbVariable.delete_gdb_variable(existing.name);
      GdbVariable.create_variable(keyExpr, "expr", displayKey);
      return new Promise(resolve => {
        let tries = 0;
        const poll = setInterval(() => {
          if (myTaskId !== _bst_op_task_id) { clearInterval(poll); resolve(null); return; }
          if (++tries > 20) { clearInterval(poll); resolve(null); return; }
          const varObj = store.get("expressions").find(obj => obj.expression === displayKey && obj.in_scope === "true");
          if (varObj && varObj.value !== undefined) {
            clearInterval(poll);
            resolve(String(varObj.value).replace(/^["'](.+)["']$/, '$1').trim());
          }
        }, 100);
      });
    };

    // ── 輔助：取得 plugin 並嘗試 reserve barrier ──────────────────────────────
    const tryReserve = (containerName) => {
      const latestCont = global_variable.__latest_containers;
      const cData = latestCont && latestCont.get(containerName);
      if (!cData) return null;
      const plugin = getPlugin(cData.type);
      if (!plugin) return null;
      const bstHist = global_variable.__bst_history;
      if (!bstHist || !(containerName in bstHist)) return null;
      if (!animScheduler.reserveBarrier()) return null; // 另一個前瞻動畫正在進行
      return { plugin, cData };
    };

    // ── 輔助：等本次停駐的容器狀態套用完畢 ────────────────────────────────────
    // detect_container_op 是在 inferior_program_paused 裡同步呼叫的，那個當下本次
    // 停駐的容器 payload 還沒抓回來，上一行的 insert/erase 也還沒進佇列。barrier
    // 只是 TTS 的閘門、不是互斥鎖（pushOps 遇到已佔用的 barrier 會直接 no-op 然後
    // 照樣 _drain），所以若立刻開始前瞻動畫，它會走在少一個節點的舊樹上，而插入
    // 動畫同時在旁邊改 history、害佈局在走訪途中整個平移重繪。
    // 因此：等到本次 payload 完成 diff（seq 遞增）且該容器佇列排空，再開始動畫。
    const waitForSettled = (containerName) => {
      const seqOf = () => (global_variable.__container_diff_seq || {})[containerName] || 0;
      const seq0 = seqOf();
      return new Promise(resolve => {
        let tries = 0;
        const poll = setInterval(() => {
          if (myTaskId !== _bst_op_task_id) { clearInterval(poll); resolve(false); return; }
          if (seqOf() !== seq0 && !animScheduler.isRunning(containerName)) {
            clearInterval(poll); resolve(true); return;
          }
          // 上限 3 秒：某些行不會更新容器（guide 沒引用它），別把動畫永遠卡住。
          if (++tries > 60) { clearInterval(poll); resolve(false); return; }
        }, 50);
      });
    };

    // ── 偵測 find / count / contains ──────────────────────────────────────────
    const matchFind = rawLine.match(/\b(\w+)\s*(?:\.|->>?)\s*(find|count|contains|lower_bound|upper_bound)\s*\(([^,)]+)/);
    if (matchFind) {
      const containerName = matchFind[1].trim();
      const keyExpr = matchFind[3].trim();
      const reserved = tryReserve(containerName);
      if (!reserved) return;
      const { plugin } = reserved;
      const requestRender = () => window.gdbgui_request_render?.();
      (async () => {
        const dk = funcName ? `bst_find::${funcName}::${containerName}::${lineNum}` : `bst_find::${containerName}::${lineNum}`;
        const value = await evalKey(keyExpr, dk);
        if (myTaskId !== _bst_op_task_id || value == null) { animScheduler.releaseBarrier(); return; }
        await waitForSettled(containerName);
        if (myTaskId !== _bst_op_task_id) { animScheduler.releaseBarrier(); return; }
        const boundOpType = matchFind[2] === 'lower_bound' ? 'lowerBound'
                           : matchFind[2] === 'upper_bound' ? 'upperBound'
                           : 'find';
        const animPromise = plugin.prospectiveOp(containerName, boundOpType, value, requestRender);
        if (!animPromise) { animScheduler.releaseBarrier(); return; }
        animPromise.then(() => animScheduler.releaseBarrier());
      })();
      return;
    }

    // ── 偵測 insert / emplace（重複鍵 for set/map）────────────────────────────
    const matchIns = rawLine.match(/\b(\w+)\s*\.\s*(insert|emplace)\s*\(\s*\{?\s*([^,{})]+)/);
    if (matchIns) {
      const containerName = matchIns[1].trim();
      const keyExpr = matchIns[3].trim();
      const latestCont = global_variable.__latest_containers;
      const cData = latestCont && latestCont.get(containerName);
      if (!cData || (cData.type !== 'set' && cData.type !== 'map')) return;
      const reserved = tryReserve(containerName);
      if (!reserved) return;
      const { plugin } = reserved;
      const requestRender = () => window.gdbgui_request_render?.();
      (async () => {
        const dk = funcName ? `bst_dup::${funcName}::${containerName}::${lineNum}` : `bst_dup::${containerName}::${lineNum}`;
        const value = await evalKey(keyExpr, dk);
        if (myTaskId !== _bst_op_task_id || value == null) { animScheduler.releaseBarrier(); return; }
        const keyStr = String(value);
        const isDup = cData.type === 'map'
          ? cData.values.some(v => String(v.key) === keyStr)
          : cData.values.some(v => String(v) === keyStr);
        if (isDup) {
          await waitForSettled(containerName);
          if (myTaskId !== _bst_op_task_id) { animScheduler.releaseBarrier(); return; }
          const animPromise = plugin.prospectiveOp(containerName, 'dupInsert', keyStr, requestRender);
          if (!animPromise) { animScheduler.releaseBarrier(); return; }
          animPromise.then(() => animScheduler.releaseBarrier());
        } else {
          animScheduler.releaseBarrier(); // 非重複，讓 state diff 在下一個 pause 觸發 insert 動畫
        }
      })();
    }
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