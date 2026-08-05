// ── `[fast @N]` 的一次跳實作 ────────────────────────────────────
//
// 舊做法是前端每個停駐點送一次 `next`，N 步就是 N 次 websocket round trip，
// 使用者看得到整段中間過程。新做法把整段步進推進 GDB 行程內：送一道
// `python exec(...)`，GDB 自己 step 到目標、沿途收集每一個堆疊，最後印一個
// JSON blob 回來。前端一次 ingest 全部堆疊，畫面只更新一次。
//
// 為什麼不是新的 HTTP endpoint（原本的 C 案）：app.py:481 那條 green thread
// 迴圈用 get_gdb_response(timeout_sec=0) 輪詢每個 session，HTTP route 自己對
// 同一個 controller 送命令的話，回應會被那條迴圈吃掉。走既有的 run_gdb_command
// 管線就沒有這個問題，而且伺服器零改動。
//
// 實測（容器內、教案 17）：78 個中間停駐點、整趟 0.28 秒，落地點與逐行計數
// 都與逐步走完全一致。

import { createCallTree, ingestStack } from "./callTree";
import type { Frame } from "./callTree";
import { global_variable } from "./global_variable";

/** blob 的包裹標記。GDB console 輸出裡混了別的訊息，靠這對標記切出來。 */
export const FF_BEGIN = "@@FF@@";
export const FF_END = "@@/FF@@";

/** 安全上限：打錯的目標次數不該讓 GDB 在行程內無限 step。 */
export const JUMP_STEP_LIMIT = 5000;

export interface JumpBlob {
  /** 沿途每一個停駐點的完整堆疊，由新到舊，最後一筆是落地點。 */
  stacks: Frame[][];
  /** 每一行被停駐的次數（含落地那一次）。 */
  counts: Record<string, number>;
  /** 是否真的走到目標。false 代表撞上限或程式先結束了。 */
  landed: boolean;
  steps: number;
}

// ── ① 命令產生 ──────────────────────────────────────────────

/**
 * GDB 行程內要跑的 Python。**不可以出現雙引號**——整段會被塞進單行的
 * `python exec("...")`，雙引號會把外層字串截斷。組完會 assert 一次。
 */
const JUMP_SCRIPT = [
  "import gdb, json",
  "_ST=[]",
  "_C={}",
  "_ok=False",
  "_i=0",
  "while _i<__LIMIT__:",
  "    gdb.execute('next', to_string=True)",
  "    _i+=1",
  "    try:",
  "        _f=gdb.newest_frame()",
  "    except Exception:",
  "        break",
  "    if _f is None: break",
  "    _fr=[]",
  "    _g=_f",
  "    while _g is not None:",
  "        _a=[]",
  "        try:",
  "            for _s in _g.block():",
  "                if _s.is_argument:",
  "                    try: _a.append({'name':_s.name,'value':str(_g.read_var(_s))})",
  "                    except Exception: pass",
  "        except Exception: pass",
  "        _sal=_g.find_sal()",
  "        _fn=''",
  "        try: _fn=_sal.symtab.fullname()",
  "        except Exception: pass",
  "        _fr.append({'func':_g.name() or '??','addr':hex(_g.pc()),'line':(_sal.line if _sal and _sal.line else ''),'fullname':_fn,'args':_a})",
  "        _g=_g.older()",
  "    _ST.append(_fr)",
  "    _ln=_fr[0]['line']",
  "    _C[str(_ln)]=_C.get(str(_ln),0)+1",
  "    if _ln==__LINE__ and _C.get(str(__LINE__),0)>=__NEED__:",
  "        _ok=True",
  "        break",
  "print('__BEGIN__'+json.dumps({'stacks':_ST,'counts':_C,'landed':_ok,'steps':_i})+'__END__')",
].join("\n");

/**
 * 組出要送給 GDB 的單行命令。
 *
 * `remaining` 是「還要再造訪目標行幾次」，不是目標次數本身——武裝當下已經
 * 停在該行第 current 次，所以呼叫端要傳 target - current。
 */
export function buildJumpCommand(
  targetLine: number,
  remaining: number,
  limit: number = JUMP_STEP_LIMIT
): string {
  const script = JUMP_SCRIPT.replace(/__LIMIT__/g, String(limit))
    .replace(/__LINE__/g, String(targetLine))
    .replace(/__NEED__/g, String(remaining))
    .replace(/__BEGIN__/g, FF_BEGIN)
    .replace(/__END__/g, FF_END);
  if (script.includes('"')) {
    // 組壞了就寧可不送：送出去只會得到一個語法錯誤的 GDB 命令
    throw new Error("fastForwardJump: script must not contain double quotes");
  }
  const escaped = script.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
  return `python exec("${escaped}")`;
}

// ── ② blob 解析 ─────────────────────────────────────────────

/**
 * 從 GDB console 輸出裡切出 blob。找不到標記或 JSON 壞掉一律回 null——
 * 失敗模式是「沒有跳成功」，呼叫端退回逐步播放，而不是讓教案整個壞掉。
 */
export function extractJumpBlob(text: unknown): JumpBlob | null {
  if (typeof text !== "string") return null;
  const start = text.indexOf(FF_BEGIN);
  if (start < 0) return null;
  const end = text.indexOf(FF_END, start + FF_BEGIN.length);
  if (end < 0) return null;
  const json = text.slice(start + FF_BEGIN.length, end);
  try {
    const parsed = JSON.parse(json);
    if (!parsed || !Array.isArray(parsed.stacks)) return null;
    return {
      stacks: parsed.stacks,
      counts: parsed.counts || {},
      landed: !!parsed.landed,
      steps: Number(parsed.steps) || 0,
    };
  } catch {
    return null;
  }
}

// ── ③ 套用 ──────────────────────────────────────────────────

/**
 * 把 blob 灌進呼叫樹與造訪計數，回傳落地點的 frame（給 inferior_program_paused）。
 *
 * 計數要扣掉落地那一次：呼叫端接著會呼叫 inferior_program_paused，那裡本來就
 * 會替落地行 +1（Actions.ts:143）。不扣的話落地行會多算一次，而它正是後面所有
 * `| @N` 段落選擇的依據。
 */
export function applyJumpBlob(blob: JumpBlob): Frame | null {
  const gv = global_variable as any;
  if (!blob.stacks.length) return null;

  if (!gv.__call_tree) gv.__call_tree = createCallTree();
  let result = null;
  for (const stack of blob.stacks) {
    if (!Array.isArray(stack) || !stack.length) continue;
    try {
      result = ingestStack(gv.__call_tree, stack);
    } catch {
      // 單一筆壞掉不該讓整棵樹放棄——其餘的照灌
    }
  }
  if (result) {
    gv.__call_graph_nodes = result.nodes;
    gv.__call_graph_edges = result.edges;
    gv.__active_node_id = result.activeNodeId;
    gv.__active_path = result.activePath;
    gv.__just_returned = result.justReturned;
  }

  const landing = blob.stacks[blob.stacks.length - 1][0];
  const landingLine = String(landing.line);

  if (!gv.__line_visit_count) gv.__line_visit_count = {};
  if (!gv.__visited_lines) gv.__visited_lines = new Set<number>();
  for (const [line, n] of Object.entries(blob.counts)) {
    const add = line === landingLine ? n - 1 : n; // 落地那一次留給 inferior_program_paused
    if (add > 0) {
      gv.__line_visit_count[line] = (gv.__line_visit_count[line] || 0) + add;
    }
    const num = parseInt(line, 10);
    if (!isNaN(num)) gv.__visited_lines.add(num);
  }

  return landing;
}
