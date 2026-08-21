# 教案播放中的 QR Code 即時作答

2026-08-01

## 目的與決策摘要

教師播放程式教案時，能開啟教案內預先編寫的單選題。學生以自己的手機掃描一次
QR Code，輸入暱稱後即可等候、作答與查看結果；教師在自己的播放畫面即時看見作答
人數、答對人數與選項分布。

除使用者已選定的自動觸發外，本規格在未指定處採下列預設，以完成內網課堂互動的核心流程：

* 學生不登入帳號，輸入暱稱即可參與；一個瀏覽器裝置憑證對同一題只能送出一次答案。
* 題目隨教案保存，播放執行到題目綁定的程式碼行時**自動開題**；教師仍可關題與決定何時
  繼續播放。行號不是單獨保存，而是與程式碼錨點一起追蹤及驗證，避免一般插入／刪除造成
  題目錯位。
* 第一版只支援單選題。這足以準確統計答對人數，且不引入文字答案判分、排名、作答
  紀錄匯出或帳號成績等另一個子系統。
* 課堂即時狀態沿用專案已安裝的 Flask-SocketIO／socket.io-client；不新建推播服務。
* QR 的行動連結由明確設定的內網基底網址產生，絕不使用 `localhost`、`127.0.0.1`
  或 `0.0.0.0`。

本功能的資料邊界是「一場正在進行的課堂」，不是個人成績系統。教師可看聚合數字；填表題在**收卷之後**
另可依暱稱檢視個別作答以供課堂檢討（2026-08-20 新增，教師有義務在課堂上提醒學生以
匿名暱稱參加）——收卷前與單選題一律不提供這個畫面；課堂結束時會清除學生暱稱、裝置憑證與逐筆答案，只
保留各題的匿名統計摘要。

## 範圍與非目標

### 本次交付

1. 在既有教案 bundle 中建立、編輯、刪除與排序單選題。
2. 教師啟動一場和某個教案快照綁定的即時課堂、顯示 QR Code、依序自動觸發／關題與結束
   課堂。
3. 不登入的學生從 QR 連結進入手機友善頁面、輸入暱稱、等候、作答與查看解答。
4. 即時顯示已加入、已作答、答對與各選項人數；結束後保留匿名題目摘要。
5. 內網部署檢查、QR 像素解碼的自動化測試，以及 Android Emulator 的真實掃碼人工
   驗收方式。

### 明確不做

* 不做文字題、複選題、檔案上傳、倒數計時、排行榜、總分、個人成績或匯出名單。
* 不做手動挑選題目開題。每一題都由播放到其已驗證的程式碼位置自動觸發，避免講解節奏
  與題目順序脫節；教師只有「關題並繼續」與「結束課堂」控制權。
* 不做多位教師共同控制同一場課堂，也不允許同場同時開兩題。
* 不把掃碼相機嵌入本網站。學生使用手機內建相機掃描網址即可；因此內網 HTTP 部署也
  能工作，且不需取得網站的相機權限。若日後要在網站內掃碼，必須另行處理 HTTPS 與
  相機權限。

## 現有系統依據

* 後端已用 Flask、SQLite、migration 檔與 `BEGIN IMMEDIATE` 交易處理教案寫入；
  新資料表與統計遞增沿用同一模式。
* `gdbgui/server/app.py` 已初始化 `SocketIO(manage_session=False)`；前端已有
  `socket.io-client`。新功能只增加專屬 namespace，不影響 GDB 的 `/gdb_listener`。
* `SourceCode.tsx` 是教案載入、bundle 合併與儲存的唯一入口；其
  `mergeLessonBundle()` 已保留未知欄位，因此 `quiz` 能與既有的程式碼、斷點、
  程式輸入及行內 `//@` 註解一起保存，也自然納入教案版本快照。
* 目前全站是預設登入拒絕，只有 `http_util.PUBLIC_ENDPOINTS` 的 endpoint 名稱可公開。
  學生路由必須是窄白名單，不能因這個功能而開放整個 `/api/`。
* 現有 `e2e/` 有 Playwright 設定與 lockfile，但缺少 `e2e/package.json`。實作此功能前
  必須補回與 lockfile 相符的最小 manifest，否則下述 E2E 命令不可重現。

## 使用者流程

### 一、教師編寫題目

1. 教師開啟自己的教案，在現有教案操作區按「課堂題目」。
2. 題目對話框列出題目卡；教師可新增、修改、刪除與排序題目，並在 Monaco 將游標停在
   目標程式碼行後按「綁定此行」。
3. 每題包含題幹、2 至 6 個選項、唯一正確選項與可選的解說。儲存教案時，題庫隨
   bundle 一起提交；既有沒有題目的教案保持完全可用。
4. 每個啟用題目都必須有唯一、已解析的程式碼錨點；有失效錨點時顯示警告與重新綁定按鈕，
   並禁止開始課堂。教師需先儲存含題目的教案，才能開始課堂。播放未儲存的工作區不應
   建立一場內容可能消失或與教案版本不一致的課堂。

### 二、教師播放與自動開題

1. 教師載入自己已儲存的教案後按「開始課堂」。伺服器複製該教案目前版本的題目為
   本場快照，建立 `lobby` 狀態並回傳 QR 連結。
2. 播放畫面顯示 QR 圖與「已加入 0 人」。教師可重新顯示 QR，但同一課堂的 QR 不變。
3. GDB 停在綁定的程式碼行時，播放閘門先同步阻止後續自動／手動步進，再向伺服器觸發
   對應的 `ready` 題目。成功後，題目自動開啟；同一題絕不因迴圈或往返同一行而再開一次。
4. 老師即時看到 `加入人數／已作答／答對人數／選項分布`。教師按「結束作答並繼續」後，
   題目封存、正解與解說推送給學生，且解除播放閘門；GDB 不會在關題瞬間自行跑下一步。
5. 全部題目完成後按「結束課堂」。這會關閉仍開啟的題目、保存匿名統計摘要，並清除
   學生可識別資料與答題列。

### 三、學生手機流程

1. 學生掃 QR Code，手機開啟 `/join/<signed-token>`。頁面只顯示課堂名稱、暱稱欄位與
   加入按鈕，不會洩漏教案程式碼、題庫或正解。
2. 成功加入後，頁面顯示「已加入，請等待播放到題目」。重新整理、短暫斷線或 socket
   重連都用裝置 cookie 回復原本的參與者身分，不必再次計數。
3. 題目開啟時顯示題幹及選項；送出前可更改選擇，送出後按鈕鎖定並顯示「答案已收到」。
4. 題目關閉後才顯示是否答對、正確選項與解說。已關閉或尚未開啟的題目不能以延遲請求
   補答。
5. 課堂結束或連結逾期時，頁面顯示「本次課堂已結束」，不能再讀取舊題或答案。

## 教案資料格式

在 `LessonBundle` 的頂層增加可選 `quiz` 欄位。`version: "2.0"` 保持不變，因為這是
附加資料而非既有 project bundle 的不相容格式替換。

```json
{
  "version": "2.0",
  "source_code": "...",
  "quiz": {
    "schema_version": 1,
    "questions": [
      {
        "id": "q_01j9k8m2",
        "prompt": "迴圈第一次執行後 i 的值是？",
        "options": [
          {"id": "a", "text": "0"},
          {"id": "b", "text": "1"},
          {"id": "c", "text": "2"}
        ],
        "correct_option_id": "b",
        "explanation": "i++ 在本輪結束後才遞增。",
        "trigger": {
          "kind": "source_line",
          "source_file": "example.cpp",
          "line": 18,
          "anchor": {
            "line_text": "i++;",
            "before_text": "cout << i << '\\n';",
            "after_text": "}"
          }
        }
      }
    ]
  }
}
```

`id` 只用於教案內穩定識別，不是安全憑證。前端在新增題目／選項時產生不重複字串，
並在載入時保留原 ID；後端必須重新驗證，不能信任前端。

後端 `_lesson_payload()` 與前端題目 editor 共用下列限制：

| 欄位 | 限制 |
|---|---|
| 題數 | 每篇 1 至 30 題；沒有 `quiz` 或空題庫仍可儲存，但不可開始課堂 |
| 題幹 | 去除首尾空白後 1 至 500 個 Unicode 字元 |
| 選項 | 2 至 6 個；每個 1 至 200 字元；同題 option ID 唯一 |
| 正解 | 必須剛好對應同題的一個 option ID |
| 解說 | 可空，最多 1,000 個字元 |
| 觸發器 | 必須是 `source_line`、目前 bundle 的 source file、正整數 line，且同一教案的已解析 anchor 只能屬於一題 |
| 錨點 | 三欄均為去除 `//@` 指令、正規化空白後的文字；`line_text` 不可空，首／末行的 `before_text`／`after_text` 可為空 |
| JSON | 沿用既有 lesson bundle 的總大小上限；未知 `quiz` 欄位一律拒絕 |

文字一律以 React 的純文字節點顯示，絕不以 `dangerouslySetInnerHTML` 或 Markdown HTML
插入。這同時避免教師題幹或暱稱成為 XSS 載體。

## 自動觸發、行錨點與播放閘門

自動開題的條件是「目前已開始的課堂 + 某題尚為 `ready` + GDB 真正停在該題已解析的
source file 與 line」。它不在滑鼠捲動、Monaco 游標移動、載入教案或單純顯示原始碼時觸發。
`frame.fullname` 會用與既有 SourceCode 相同的正規化規則比對題目的 `source_file`，檔案不符
（例如標準函式庫 frame）時絕不觸發；唯一入口是既有 `Actions.inferior_program_paused(frame)`，
因為這裡已有 GDB frame 的實際位置，且發生於 TTS／自動播放命令排程之前。

題目綁定與維護規則如下：

1. 作者在 Monaco 將游標放在可執行的目標行，按「綁定此行」。系統以
   `stripDirective()` 去除行末 `//@` 註解後，保存當前 line 及本行、前一行、後一行的
   正規化文字錨點。程式碼註解的修改不會誤讓題目改綁。
2. 每次 Monaco 模型內容改變、import 或載入既有教案時，`quizTrigger.ts` 重新解析：先驗證
   儲存 line 的三段 anchor；不符時掃描 source code。若只找到一個完全相符的連續三行，便
   自動更新 line；這處理在題目前插入／刪除行的正常編輯。
3. 找不到或找到多個相同 anchor 時，該題標記為 `unresolved`，不猜測要綁哪一行。UI 顯示
   原本行號與摘要，教師必須重新綁定。前端及 `_lesson_payload()` 都拒絕把 unresolved 題目
   存入教案；已儲存的舊教案載入後若因 import 失配，也必須修復才可再存或開始課堂。
4. 相同 resolved anchor 不能綁兩題；同一題在一場課堂只能從 `ready` 變成 `open` 一次。
   因此迴圈再次停同一行、reverse step、斷線重連或重送 trigger 不會重置統計或再問一次。

在 `Actions.inferior_program_paused(frame)` 中，`LessonQuizTrigger.match(frame)` 必須先於
`VisualizerHelper.play_tts()` 執行。命中時它同步設定 `quiz_playback_gate`，取消／抑制待排的
autoplay 命令，並呼叫受 CSRF 保護的 trigger API。`GdbApi` 的 next、step、continue 與
`window.gdbgui_execute_autoplay_command` 都先檢查此 gate；播放控制鈕在 gate 開啟時 disabled。
如此 network request 尚未完成時，GDB 也不能悄悄跑過題目。

trigger API 成功才讓教師 UI 顯示 open 題目。若失敗，gate 保持，顯示「無法開啟題目」與
「重試／結束課堂」；絕不自動繼續播放而跳過題目。教師按「結束作答並繼續」時，先由伺服器
成功 close 題目，前端再清除 gate。它不替教師執行下一個 GDB 命令，保留結果講解的時間。
使用者在 gate 中若按停止、重新執行或結束課堂，gate 一律清除，避免下一次播放被舊狀態卡住。

## 資料模型與生命週期

### 課堂與題目快照

建立課堂時，伺服器由 lesson id、目前 version 與擁有者身分讀取題庫，寫入獨立的
課堂題目快照。後續有人修改、還原或 fork 教案，都不會改到已開始的課堂。

```text
lobby ──GDB 停在已綁定行──> question_open ──教師關題並繼續──> lobby
  │                               │                                  │
  └──────────────────────教師結束課堂────────────────────────────────┘
                                            ↓
                                          ended
```

每場最多一題是 `open`。`ended` 是終止狀態，不能重新開題或接受新參與者。

### SQLite tables

新增一個可重跑的 migration，例如 `0010_live_quiz.sql`：

```sql
CREATE TABLE IF NOT EXISTS live_quiz_sessions (
    id                 INTEGER PRIMARY KEY,
    lesson_id          INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
    lesson_version_id  INTEGER REFERENCES lesson_versions(id) ON DELETE SET NULL,
    owner_user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title              TEXT NOT NULL,
    join_nonce         TEXT NOT NULL UNIQUE,
    state              TEXT NOT NULL CHECK (state IN ('lobby', 'ended')),
    created_at         TEXT NOT NULL,
    ended_at           TEXT
);

CREATE TABLE IF NOT EXISTS live_quiz_questions (
    id                 INTEGER PRIMARY KEY,
    session_id         INTEGER NOT NULL REFERENCES live_quiz_sessions(id) ON DELETE CASCADE,
    question_key       TEXT NOT NULL,
    prompt             TEXT NOT NULL,
    options_json       TEXT NOT NULL,
    correct_option_id  TEXT NOT NULL,
    explanation        TEXT NOT NULL,
    source_file        TEXT NOT NULL,
    trigger_line       INTEGER NOT NULL CHECK (trigger_line > 0),
    trigger_anchor_json TEXT NOT NULL,
    position           INTEGER NOT NULL,
    state              TEXT NOT NULL CHECK (state IN ('ready', 'open', 'closed')),
    opened_at          TEXT,
    closed_at          TEXT,
    answer_count       INTEGER NOT NULL DEFAULT 0 CHECK (answer_count >= 0),
    correct_count      INTEGER NOT NULL DEFAULT 0 CHECK (correct_count >= 0),
    option_counts_json TEXT NOT NULL,
    UNIQUE (session_id, question_key),
    UNIQUE (session_id, position)
);

CREATE TABLE IF NOT EXISTS live_quiz_participants (
    id                 INTEGER PRIMARY KEY,
    session_id         INTEGER NOT NULL REFERENCES live_quiz_sessions(id) ON DELETE CASCADE,
    nickname           TEXT NOT NULL,
    credential_hash    TEXT NOT NULL UNIQUE,
    created_at         TEXT NOT NULL,
    last_seen_at       TEXT NOT NULL,
    UNIQUE (session_id, credential_hash)
);

CREATE TABLE IF NOT EXISTS live_quiz_responses (
    participant_id     INTEGER NOT NULL REFERENCES live_quiz_participants(id) ON DELETE CASCADE,
    question_id        INTEGER NOT NULL REFERENCES live_quiz_questions(id) ON DELETE CASCADE,
    selected_option_id TEXT NOT NULL,
    is_correct         INTEGER NOT NULL CHECK (is_correct IN (0, 1)),
    answered_at        TEXT NOT NULL,
    PRIMARY KEY (participant_id, question_id)
);

CREATE INDEX IF NOT EXISTS live_quiz_session_owner_idx
    ON live_quiz_sessions (owner_user_id, state, created_at DESC);
CREATE INDEX IF NOT EXISTS live_quiz_question_session_idx
    ON live_quiz_questions (session_id, position);
CREATE INDEX IF NOT EXISTS live_quiz_participant_session_idx
    ON live_quiz_participants (session_id);
```

`live_quiz_questions` 持有題目與聚合欄位，因而能在清除逐筆答案後保留結果。參與者與
responses 只在課堂活躍期間存在；`end_session()` 在一個交易內先讓 session 進入 `ended`，
再刪除兩表資料。資料庫留下的是「哪一題有多少人作答／答對」，不是學生名單。

答題使用 `BEGIN IMMEDIATE`：驗證 session 和 question 尚開啟、插入 `(participant_id,
question_id)` 唯一 response、遞增題目的總數與對應選項數，最後 commit，再 emit 更新。
唯一主鍵是最後防線；重送或雙擊只會得到既有答案的成功冪等回應，不重複計數。SQLite
在此處序列化小型課堂寫入交易，可避免遺失加總；本期驗收目標為 60 位同時作答學生。

免登入只能限制「同一瀏覽器憑證」而不能證明「同一個人」：清 cookie、無痕視窗或第二台
手機仍可再參加。這是匿名即時問答的明確誠信上限；若日後需要每位學生嚴格一次，應另做
登入或教師發放的一次性名單代碼，不能假裝瀏覽器 cookie 可解決。

## API 與即時事件

所有教師 API 都沿用目前登入、同源與 CSRF 規則；不存在、非擁有者或已結束的 teacher
資源一律 404，避免洩漏課堂是否存在。

| 方法與路徑 | 用途 |
|---|---|
| `POST /api/live-quiz/sessions` | 教師從自己的已儲存 lesson 建立場次；body 只有 `lesson_id`，伺服器自行讀目前 version 與題庫 |
| `GET /api/live-quiz/sessions/<id>` | 教師重整後恢復 QR、題目與聚合狀態 |
| `POST /api/live-quiz/sessions/<id>/questions/<key>/trigger` | 由已命中 GDB frame 的教師播放端觸發對應 ready 題；驗證 owner、題目狀態與 trigger line |
| `POST /api/live-quiz/sessions/<id>/questions/<key>/close` | 關閉本題並公布結果 |
| `POST /api/live-quiz/sessions/<id>/end` | 結束場次、清除個資與逐筆答案 |
| `GET /api/live-quiz/sessions/<id>/qr.svg` | 僅教師可讀，回傳 QR SVG，並有 `Cache-Control: no-store` |
| `GET /join/<signed-token>` | 公開的學生 HTML 入口；不含題目內容 |
| `POST /api/live-quiz/guest/join` | 公開但窄化；以 token 和暱稱建立或恢復參與者 cookie |
| `GET /api/live-quiz/guest/state` | 公開但需有效參與者 cookie；回傳學生目前可見狀態 |
| `POST /api/live-quiz/guest/answers` | 公開但需有效參與者 cookie；提交一題答案 |

學生 API 的「公開」不是無驗證。`PUBLIC_ENDPOINTS` 只增加這些精確 endpoint 名稱和 join
頁；全域 CSRF before-request 對這三個 guest POST 使用一份明確的小型例外清單，而每個路由
仍必須先檢查同源、token／cookie 與場次狀態。不得以 URL 前綴、藍圖整體或 `@authenticate`
之外的旁路開放既有 API。

首次 join 成功後，伺服器產生 32 bytes 隨機 credential，資料庫只保存 SHA-256 hash，原值以
獨立 `HttpOnly; SameSite=Lax` cookie 傳回。HTTPS 部署時 cookie 同時標記 `Secure`；本機內網
HTTP 則依現有 `GDBGUI_SECURE_COOKIES` 設定保持可用。所有 guest 狀態和答題請求都由此
cookie 解析出 participant，不接受 body 裡的 participant id。

QR 的 token 是由伺服器密鑰簽署、含 session id 和隨機 `join_nonce` 的短期 token。驗證時除
簽章與時限外，還要查資料庫 nonce、場次狀態與 owner；token 不在資料庫保存為明文密碼，
結束或刪除課堂後立刻失效。QR SVG 對應的 URL 只能由受保護的 teacher endpoint 取得。

新增 Socket.IO namespace `/lesson_quiz`：

* 教師連線須有登入 session，並在 handshake 的 session id 上再驗證 owner；只加入
  `lesson_quiz:<id>:teacher` room。
* 學生連線須有有效 guest cookie，伺服器由 cookie 決定 room；客戶端不可指定別人的
  session／participant id。
* server → teacher：`quiz:teacher-state` 與 `quiz:stats`（加入數、作答數、答對數、選項
  分布、題目狀態）。
* server → student：`quiz:student-state`（等待／可作答的題幹選項／已關題結果）。自動觸發前
  與作答中絕不傳 `correct_option_id` 或 explanation。
* WebSocket 斷線由 Socket.IO 既有 polling transport 與重連處理；重新連線後 server 依
  cookie／登入身分發完整目前 state，不能只依賴漏掉的增量事件。

## 內網與 QR Code

新增必填的部署設定 `MOBILE_JOIN_BASE_URL`，例如：

```text
MOBILE_JOIN_BASE_URL=http://192.168.50.20:5000
```

建立課堂前，後端必須驗證它是絕對 `http` 或 `https` URL、沒有 query／fragment、且 host 不是
`localhost`、loopback 或 wildcard bind address。設定缺失或不合法時，教師按鈕顯示具體修正
方式，不建立半成品場次。可使用內網 DNS 名稱，但文件應優先建議固定私有 IP；手機與教師
必須在同一個可互通的 Wi-Fi/VLAN，且主機或 Docker 發佈 TCP port、Windows 防火牆都允許
該連線。訪客 Wi-Fi 的 client isolation 會使掃碼後無法連線，必須改用可互通的網路。

QR 圖以 Python 的小型 `qrcode` 套件輸出 SVG（`SvgPathImage`）；加入 `requirements.in` 並以
現有 `pip-compile` 重建鎖定的 `requirements.txt`。SVG 不需 Pillow、檔案儲存或前端 QR
函式庫。QR payload 是 `${MOBILE_JOIN_BASE_URL}/join/<signed-token>`，不含正解、學生
資料或 lesson bundle。

開始課堂面板在 QR 下顯示完整可複製 URL、設定中的 host 與「請用一支非教師手機測試」提示。
這是診斷內網問題最短的路徑；不能把「手機無法連」誤報成題目或 QR 錯誤。

## QR 掃碼模擬與驗證

### 自動化：實際解碼 QR 像素，再以手機瀏覽器答題

Playwright 已支援 iPhone 13 等裝置的 viewport、user agent、touch 與 mobile 設定，故以兩個
獨立 browser context 模擬「教師桌機」與「學生手機」而不需要真機。

1. 修復 `e2e/package.json`，保留 lockfile 的 `@playwright/test@1.44.0`，新增只供 E2E 使用的
   `jsqr`。這是測試依賴，不能進入正式網站 bundle。
2. E2E 以教師 session 建立課堂並顯示 QR；取得 `<img>` 的 SVG URL，載入後 rasterize 到 canvas。
3. 以 `jsQR` 對 canvas 的 RGBA pixel buffer 解碼，assert 結果是設定的內網 base URL 加上有效
   `/join/` token。不得讀取 DOM 的 `href` 或直接拼 URL，否則沒有驗證 QR 圖真的可掃。
4. 用 Playwright `devices['iPhone 13']` 建立另一個 context，`goto(decodedUrl)`，輸入暱稱；
   再讓教師端的 GDB fixture 執行到綁定行，自動開題、提交答案，並 assert 教師畫面收到
   正確的即時統計。
5. 另跑兩個 iPhone contexts 對同一題同時 POST、重送其中一人的答案，assert answer count
   僅增加兩次且答案不可覆蓋。

官方 Playwright 文件說明裝置設定會模擬手機的 user agent、螢幕、viewport 與 touch：
<https://playwright.dev/docs/emulation>。

### 人工驗收：Android Emulator 虛擬相機

這是自動化之外驗證「相機真的讀得出畫面上的 QR」的選配步驟：

1. 啟動支援相機的 Android AVD，先用專案的 teacher UI 下載或截取本場 QR PNG。
2. 開啟 Emulator 的 **Extended controls → Camera → Virtual scene images**，把 QR PNG／JPEG
   加入虛擬場景；或以 Emulator 的 `imagefile:` camera source 指向該檔案。
3. 在 Emulator 使用相機或系統掃碼功能掃此 QR。若伺服器跑在開發主機，這一次測試的
   `MOBILE_JOIN_BASE_URL` 可暫設為 `http://10.0.2.2:5000`；它是 Android Emulator 指向宿主
   loopback 的專用位址，僅供 emulator，不能給真實學生手機使用。
4. 確認掃碼結果開啟學生 join 頁、輸入暱稱、播放到已綁定行後收到題目並送出答案。真實內網驗收則改回
   私有 LAN IP，使用實體手機再走一次。

Android 官方文件明確支援把 PNG/JPEG（包含 QR Code）匯入 Emulator 的 virtual scene，供
任何相機式 app 使用：<https://developer.android.com/studio/run/emulator-use-camera?hl=en>。
因此 Emulator 是「相機掃描」的人工驗收，Playwright 則是快速、可重現的 CI 驗證；兩者
互補，不能以只導覽 URL 冒充掃到 QR。

## 前端邊界

| 元件／模組 | 職責 |
|---|---|
| `quizSchema.ts` | 純型別、預設值、bundle 驗證與題目 snapshot helper；Jest 可不掛載 Monaco 測試 |
| `quizTrigger.ts` | 純行錨點解析、唯一性檢查與 `frame` 比對；不含 UI 或 fetch，能完整 Jest 測試 |
| `QuizAuthoringDialog` | 教案擁有者編寫與排序題目，並從目前 Monaco 行建立／修復 trigger；只改 bundle template，儲存仍走既有教案流程 |
| `LessonQuizTrigger` | 接在 `Actions.inferior_program_paused`，同步設播放 gate，命中時呼叫 trigger API；是自動開題唯一入口 |
| `LiveQuizPanel` | 教師開始課堂、顯示 QR、當前自動開啟題目的即時統計、關題並繼續與結束課堂 |
| `StudentQuizApp` | 由 `/join/<token>` 載入的最小手機頁；不載入 GDB、Monaco 或教案程式碼 |
| `liveQuizClient.ts` | 小型 fetch／Socket.IO adapter，集中 reconnect 和 state 更新；不混入既有 GDB socket adapter |

`SourceCode.tsx` 只負責把 `quiz` 放進／取出 lesson bundle、顯示兩個教師入口並在卸載時關閉
teacher socket。學生頁使用獨立 entry point 與精簡 CSS，按鈕至少 44×44 px、文字與選項能在
320 px 寬度呈現、以 `aria-live="polite"` 通知「已收到答案／老師已關題」等狀態。顏色不能
是答對與答錯的唯一提示，必須有圖示或文字。

## 授權、隱私與錯誤處理

| 情況 | 必要行為 |
|---|---|
| 非擁有者建立、讀取、觸發、關題或結束課堂 | 回 404；前端不顯示可用控制項 |
| QR token 偽造、過期、nonce 不符或課堂已結束 | join 頁與 guest API 回 404/410，不說明 session 是否曾存在 |
| 暱稱空白、過長或格式錯誤 | 400，前端在欄位旁提示，不建立 participant |
| 同一 credential 重送同一題 | 回既有提交狀態，統計不再增加 |
| 題目未開／已關／已結束後提交 | 409，手機刷新狀態；後端絕不接受 |
| GDB 命中失效／歧義錨點 | 不可開始課堂；明確列出需重新綁定的題目，絕不以最近行號猜測 |
| 自動 trigger API 失敗 | 播放 gate 維持，教師可重試或結束；不可跳過題目後繼續播放 |
| 教師重新整理或 socket 重連 | 用受保護 `GET session` 回復，同步完整 state |
| 學生重整或 socket 重連 | 用 guest cookie 回復，不能新增加入人數 |
| Socket.IO 暫時不可用 | HTTP 初始 state 仍可讀；client 顯示重連中，恢復後取完整 state |
| `MOBILE_JOIN_BASE_URL` 不可用 | 不建立場次，顯示設定／網路檢查提示 |
| 兩位學生同時送出 | transaction 與 DB 唯一鍵維持正確總數；commit 後才推播 |

伺服器 log 只能記錄 session id、question id、錯誤原因與聚合計數；不記錄 QR token、guest
credential、完整暱稱或所選答案。QR 畫面和 join URL 是暫時的 bearer invitation，教師應避免
投影給非本課學生；結束課堂使其立即失效。

## 測試與驗收準則

### Python／資料庫

* migration 從空資料庫與有既有 lesson／lesson_versions 的資料庫都可重跑；不改壞舊 bundle。
* owner 建場時複製正確 lesson 目前版本題目；後續更新／還原 lesson 不影響 session snapshot。
* 非 owner 所有 teacher API 都得 404；課堂無題目、資料不合法、非法 base URL 都拒絕。
* join token、nonce、guest credential 和已結束狀態均 fail closed；跨來源 guest POST 被拒絕。
* 同一 participant 連續或並行答同一題只計一次；60 個不同 participant 的並行答題，
  `answer_count`、`correct_count` 與每一選項分布都精準相加。
* 關題關閉前不會從任一 student API／Socket event 取得正解或 explanation；關閉後才出現。
* 結束課堂留下題目聚合摘要，並刪除 participants、responses、credential hash 與暱稱。

### Jest

* quiz schema 接受合法單選題，拒絕重複 ID、空題幹、錯誤正解、過多選項、未知欄位與
  重複／缺失 trigger。
* `mergeLessonBundle()` 後題庫與 source code、`//@` 註解、breakpoints 和 program input 都保留。
* 題目排序、新增、刪除及 snapshot helper 不改動原 lesson object。
* 行錨點在題目前插入、刪除行後會唯一地重定位；相同三行 anchor、改掉綁定行或多個候選
  時一律變成 unresolved，絕不猜測。
* `Actions.inferior_program_paused` 命中 ready 題時在 TTS／autoplay 前開 gate；所有 next、
  step、continue、autoplay 都被 gate 擋住，close 成功後才可由教師繼續。
* 學生／教師 state reducer 在 open、answer、close、end 與重連完整 state 時正確更新，
  而不意外顯示正解。

### E2E 與人工驗收

* 教師建立／顯示 QR，測試以像素解碼而非讀 href；iPhone context 能進入 join 頁。
* iPhone 學生加入、等待；教師實際播放到綁定行時題目自動開啟、播放控制被鎖定。答對／
  答錯、關題後看見解說；教師的總答、答對和選項數即時更新。
* 迴圈或 reverse step 再次命中同一行不會重開題目；失效 anchor 的教案無法開始課堂。
* 雙擊、重送、重新整理、重連和課堂結束後重開 QR 都符合上表。
* 以 60 個獨立 guest context 或 API fixture 進行受控壓力驗證，所有答案送出後三秒內教師
  收到正確最終統計。
* Android Emulator 虛擬相機可掃 QR，及至少一台真實手機在設定的 LAN IP 下能進入同一流程。

## 實作順序

1. 補足 E2E manifest，建立 `quizSchema` 的 Jest 測試與純資料驗證，確定 bundle 向後相容。
2. 新增 migration、DB repository、owner API 與 Python 測試；先處理 session snapshot、原子答題
   與清除資料，再接 UI。
3. 加入 public join／guest credential 的窄白名單與其安全測試；確認不會放寬現有登入閘門。
4. 建立題目編輯對話框、`quizTrigger.ts` 及 Monaco 行錨點，接到 `SourceCode.tsx` 既有
   lesson 儲存與版本流程；先用 Jest 鎖住重定位與 unresolved 行為。
5. 加入 `LiveQuizPanel`、播放 gate、QR SVG 與 `/lesson_quiz` namespace；以實際
   `Actions.inferior_program_paused` frame 驗證自動開題與不續播。
6. 建立獨立學生 entry page，完成行動版可用性、reconnect 和關題結果。
7. 寫 QR 像素解碼＋iPhone E2E、併發答題測試，再做 Android Emulator 與實機內網驗收。

這個順序讓公開 guest 邊界與統計正確性先被測試鎖住，再加入教師／學生介面；任何 UI 完成
後都不能略過 token、權限、關題前不洩漏正解、以及重送不重複計數這四個不變條件。
