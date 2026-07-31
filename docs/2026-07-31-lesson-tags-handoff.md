# 教案標籤與主頁瀏覽 — 交接文件

2026-07-31

這份文件是給**接手的人**看的。功能做到一半，session 撞到 API 限制中斷。
讀完這份應該能直接接下去，不需要回頭翻對話。

---

## 這是什麼功能

兩件事綁在一起做：

1. **教案標籤** —— 全站共用的標籤詞彙，只有作者能改自己教案的標籤
2. **主頁換成教案瀏覽** —— `/` 從除錯器改成可搜尋、可依標籤篩選的清單，除錯器搬到 `/edit`

搜尋一個框通吃（比對標題／作者／標籤），加上可複選的標籤列，**全部條件之間是 AND**。

## 三份權威文件

| 文件 | 用途 |
|---|---|
| `docs/superpowers/specs/2026-07-30-lesson-tags-and-browse-design.md` | 設計決策與理由 |
| `docs/superpowers/plans/2026-07-30-lesson-tags-and-browse.md` | 八個任務的實作計畫，含完整程式碼與測試 |
| `.superpowers/sdd/2026-07-30-lesson-tags-and-browse/progress.md` | **ledger——真正的進度來源** |

`.superpowers/` 被 gitignore，所以 ledger 不在版控裡。**它是這個流程的恢復地圖**：
每個任務的完成、每一輪修正、每一條被擱置的發現都記在裡面。接手時先讀它，
不要相信記憶或這份文件的摘要——ledger 與 `git log` 才是真的。

同目錄下還有每個任務的 `task-N-brief.md`（從計畫抽出的任務需求）與
`task-N-report.md`（實作者的完整報告，含測試輸出與突變驗證證據）。

---

## 進度：5.5 / 8

| # | 任務 | 狀態 | 最後 commit |
|---|---|---|---|
| 1 | 資料表與標籤正規化 | ✅ 完成 | `f32c795` |
| 2 | 標籤與教案的關聯讀寫 | ✅ 完成 | `2dadcbf` |
| 3 | 搜尋與標籤計數 | ✅ 完成 | `990bfeb` |
| 4 | 標籤 API | ✅ 完成 | `8a60393` |
| 5 | 路由換位與轉址 | ✅ 完成 | `20c49f0` |
| 6 | 瀏覽頁模板 | ⚠️ **未提交、未審查** | — |
| 7 | 個人檔案頁的標籤編輯 | ⬜ 未開始 | — |
| 8 | e2e | ⬜ 未開始 | — |

BASE commit（這個功能開始前）：`47d046b`

### 目前的工作區狀態 ★ 先處理這個

`git status` 有三個檔案的**未提交改動**，來自被中斷的 Task 6：

```
 M gdbgui/templates/_auth_base.html   (+53)
 M gdbgui/templates/lessons.html      (+103/-31)
 M tests/test_routes_swap.py          (+21)
```

**這些改動是好的，不是壞的**（我驗過）：

* Jinja 語法正確——用 `env.parse()` 直接編譯兩個模板都通過，區塊 18/18 與 2/2 配對
* 沒有真正的 `|safe` 用法（唯一一處是註解裡的說明文字，原版就有）
* `tests/test_routes_swap.py` **13 passed**（Task 5 的 11 條 + Task 6 新增的 2 條）

備份在 `.superpowers/sdd/2026-07-30-lesson-tags-and-browse/task-6-wip.patch`（259 行），
所以就算 `git checkout --` 掉也救得回來。

**Task 6 還沒做完的部分：**

1. 突變驗證（把搜尋框從模板拿掉 → `test_the_root_renders_the_browse_ui` 該紅；
   讓模板忽略 `selected_tags` → 有沒有測試會紅？沒有的話是覆蓋破洞）
2. 全套件回歸對照（與 BASE `20c49f0` 比，FAILED 清單必須逐條相同）
3. 手動視覺確認（`docker compose up -d --build` 後開 <http://localhost:5000/>）
4. 提交
5. scoped task review

---

## 剩下要做什麼

### Task 6（收尾）
見上。計畫檔的 Task 6 有完整的模板與 CSS 程式碼。

### Task 7：個人檔案頁的標籤編輯
`auth.py` 的 `profile()` 帶 `lesson_tags` 給模板、`profile.html` 加逗號分隔的編輯表單
（只在看自己的頁面時出現）。計畫有完整程式碼。

`auth.py:33` 的 `from . import blocking, db` 要改成 `from . import blocking, db, tags`；
其餘 import 都已存在。

### Task 8：e2e ★ 範圍比原計畫大
新增 `e2e/tests/zz_lesson_tags.spec.ts`，並讓既有測試跟上新路由。

**原計畫只列了 `zz_lesson_sharing.spec.ts`，這是錯的。** Task 5 的審查者靜態盤點出
**17 個 spec** 假設 `/` 是除錯器，全部要把 `goto('/')` 換成 `goto('/edit')`：

```
f5_breakpoints, linear, memwatch_screenshot, ordered, restricted, run_button,
smoke(3 處), tutorial_import_run, unordered, zz_annotations_layout_run,
zz_annotations_modal_playmode, zz_bst_animation, zz_fast_forward, zz_for_substep,
zz_pause_button, zz_read_file_confinement, zz_system_header_source
```

計畫檔已經更新（commit `48b7345`）。**替換時只改導覽網址，不要順手動任何斷言**——
那些 spec 驗的東西與這次變更無關，改了就分不清失敗是路由造成還是被改壞的。

### 最終全分支審查
八個任務都完成後，對 `47d046b..HEAD` 做一次完整審查，並把 ledger 裡
「deferred / parked」那些項目一併分類。

---

## 環境陷阱（會浪費你半天的那些）

### 原生 Windows 跑不了大部分 Python 測試
`gdbgui/server/sandbox/jail_manager.py` 無條件 `import pwd`（POSIX-only），
所以任何需要 `flask_app` fixture 的測試在 collection 階段就會爆。

**一律用容器跑：**

```bash
docker run --rm -v "<路徑>:/app" -w /app cppviz-pytest \
  python -m pytest tests/test_xxx.py -q -p no:randomly
```

`cppviz-pytest` 映像 = `cppcodevisualizer-gdbgui` + `pip install pytest`
（現有的兩個映像都沒裝 pytest）。不在的話重建：

```dockerfile
FROM cppcodevisualizer-gdbgui
RUN pip install -q pytest
```

### 全套件有 33 條「正常」的失敗
容器缺 `CAP_SYS_ADMIN`，`unshare` 失敗，所以 jail／沙盒類測試跑不了：
`test_binary_path_isolation`(4)、`test_execution_isolation`(9)、
`test_file_read_confinement`(13)、`test_read_file_hub_responsiveness`(2)、
`test_sessionmanager`(1)、`test_signal_authz`(3)、`test_user_isolation`(1)。

**判斷回歸的方法是與 BASE 對照 FAILED 清單，不是看數字。** 每次都
`git archive` 兩個版本到 scratchpad 各跑一次，排序後 `diff`，必須零差異。

### 測試資料庫整個 session 共用、不跨測試隔離
`conftest` 只建一次。所以任何依賴「精確集合相等」的斷言都必須讓字面值唯一
（見 `tests/test_lesson_search.py` 的 `corpus` fixture 用 `uuid.uuid4().hex[:8]` 後綴）。
`tests/test_lesson_quotas.py` 因為同樣理由用 `_site_bytes_used()` 相對計算。

**這個坑在這個計畫踩了兩次。**

### 其他
* `git commit` 會觸發 pre-commit 跑 jest（約 15 秒、283 個測試）。不要 `--no-verify`。
* 主控台對中文輸出會亂碼，那是顯示問題不是測試失敗，看 `passed`/`failed` 數字。
* Git Bash 的 `tar -xf ... -C "C:/..."` 會把 `C:` 當遠端主機。先 `cd` 進去再解。
* e2e 一律加 `--build`：
  `docker compose -f docker-compose.test.yml run --rm --build e2e npx playwright test`

---

## 這個計畫反覆出現的一種缺陷

**測試斷言不到它宣稱的性質。** 到目前為止已經抓到並修正 **十條**，全部是計畫裡
我寫的測試，實作者逐字照抄無過失。典型形狀：

* 用不存在的資料查詢，所以「有沒有截斷」結果都一樣
* 對本來就沒有標籤的教案斷言「標籤沒變」，所以實作對錯都成立
* 白箱斷言比對 SQL 字串常數，但那條路徑可以從 Python 層被改壞
* 全域斷言（`== []`）在共用資料庫裡靠執行順序才成立

**所以每個任務都要求突變驗證**：把該性質刻意弄壞一次，確認測試會紅。
指派修正時要**把必須被殺掉的那段確切程式碼貼給實作者**，並要求雙向驗證
（套上變紅、還原變綠）都貼輸出——曾經發生過實作者驗了自己挑的另一個突變
就回報「已修好」的情況。

**突變只能作用在 `git archive HEAD` 匯出到 scratchpad 的副本上**，
不要直接改工作目錄再還原（中途一斷就會把突變留在工作樹裡）。

---

## 已知但刻意沒做的事（ledger 有完整版）

| 項目 | 說明 |
|---|---|
| `explain_error` / `generate_lesson` 的 fail-open | 與標籤 API 修掉的是同一個寫法（`get_json(silent=True) or {}` + `.get`），解析失敗會靜默走預設值。全域 16 MB 上限蓋住了大小問題，但 fail-open 那部分還在 |
| 16 MB 上限對真實教學 binary 夠不夠 | 零測試覆蓋。`/upload` 收的是帶除錯符號的執行檔，要驗需量一份 `-g` 編譯的實際檔案 |
| Werkzeug 的 413 回 HTML 不是 JSON | 前端若對 `/upload` 或教案儲存做 `response.json()` 會拿到解析錯誤而不是可讀訊息 |
| e2e 完全沒有碰過 `/dashboard` | `grep -rln "dashboard" e2e/tests/` 零命中。dashboard 的兩條網址生成邏輯因此沒有端對端覆蓋——這正是 Task 5 那兩個 Critical 能潛伏的原因 |
| 登入／註冊成功後導向 `/edit` | 行為語意未變，但「首頁已是瀏覽頁」之後要不要改導向是產品決定 |
| `set_lesson_tags` 沒有 fail-closed 的 id 驗證 | 沒比照 `db._require_lesson_id`。`user_id=True` 且教案屬於 user 1 時 `1 != True` 為 False。目前不可達（session 的 `user_id` 是 int） |

## 開發資料庫的狀態

執行中的 `cppcodevisualizer-gdbgui` 容器資料庫裡有 **39 篇教案、0 個標籤**，
大部分是這個 session 的 e2e 與測試留下的（`E2E 教案 …`、`ISO …`、`讀者的版本 …`）。
不影響功能，但做手動視覺確認時畫面會有一堆雜訊。要清就用
`DELETE /api/lessons/<id>`（只能刪自己的）。

---

## 怎麼接下去

這個功能是用 `superpowers:subagent-driven-development` 流程做的：每個任務派一個
fresh subagent 實作，完成後派另一個做 scoped review，有問題就進 fix loop
（最多 5 輪），每一步都記進 ledger。

要沿用的話：

```
Skill: superpowers:subagent-driven-development
args: 執行 docs/superpowers/plans/2026-07-30-lesson-tags-and-browse.md（8 個任務）
```

它會讀 ledger、看到 Task 1-5 已完成，從 Task 6 接下去。

不沿用也可以——計畫檔裡每個任務都有完整的程式碼與測試，照著做就行。但
**突變驗證那一段不要省**，這個計畫十條有問題的測試全是靠它抓出來的。
