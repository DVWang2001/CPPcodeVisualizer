# AI 教案生成實驗數據（2026-10-26）

目的：找出怎麼讓 deepseek-ai/deepseek-v4.1-flash 穩定產出可自動播放的 `//@` 教案。
全部在正式機容器內，用 NVIDIA 端點（`https://integrate.api.nvidia.com/v1`）實測。

## 設定

| 項目 | 值 |
|---|---|
| 模型 | `deepseek-ai/deepseek-v4.1-flash`（NVIDIA 目錄僅剩此版；舊預設 `-v4-flash-0731` 已下架） |
| temperature | 0.3 |
| max_tokens | 16384 |
| 系統提示 | `AUTHORING_GUIDE.md` 全文（約 69 KB、輸入約 2.2 萬 tokens）+ `lesson_gen._SYSTEM_TEMPLATE` 的 11 條硬規則 |
| 輸入 | 6 份人工教案去掉 `//@` 註解（見下）；`program_input` 沿用原 bundle |
| 評分工具 | `scripts/score_lesson.py`（commit `e1af6a7b`，之後只改過預設模型名） |
| 跑台 | `run_eval.py`（變體比較）、`run_route_eval.py`（端到端打真正的路由） |

### 考題（各類一份，來自 `examples/lessons/`）

| 代號 | 主題 | 原檔 | 人工教案 S 分數 |
|---|---|---|---|
| for | for 迴圈：因數抽血 | `for迴圈_因數抽血/factor_sum.json` | 100 |
| while | while 迴圈：考拉茲猜想 | `while迴圈_考拉斯猜想/collatz.json` | 100 |
| recursion | 遞迴：費氏數列記憶化 | `遞迴_費氏數列_記憶化TopDown/fib_memo.json` | 90 |
| vector | vector：泡沫排序 | `vector經典_排序/bubble_sort.json` | 88 |
| dp | DP 課 2：雙層迴圈填表 | `DP課2_雙層迴圈填表/dp2_grid.json` | 100 |
| string | string：回文判斷 | `string經典_迴文判斷/palindrome.json` | 100 |

## 評分標準

- **G 門檻（任一不過整份記 0）**：G1 程式碼沒被改、G2 只有程式碼、G3 每個停駐點有 `@tts`、
  G4 每個 `@N` 段落有自動播放指令且最後一站 `[continue]`、G5 沒引用該行才宣告的變數、G6 註解語法合法。
- **S 結構分（0–2，N/A 不計；換算成百分比）**：S1 不標在不會停的行、S2 `@N` 門檻有依據、
  S3 for 行不引用自己的迴圈變數、S4 讀資料行不講／無殘留 program_input、
  S5 遞迴規則（`result`、一行一呼叫、return 行「← 由來」、呼叫行 `[step-in]`）、S6 停駐行覆蓋率。
- **Q 教學品質（0–2，模型代評）**：Q1–Q7。**已實作但本輪沒有跑**，所以沒有 Q 的數據。

校準：同一把尺對 `examples/lessons/` 的 67 份人工教案 → 全部通過 G，S 平均 97.5%
（`human_lessons_calibration.csv`）。

## 實驗一：正式機上 deepseek 的原始教案（lesson #52）

`lesson52-original/deepseek_lesson52.gdbgui.json`。問題：`for (int i = 0; …) 10 % i` 在 i=0 當掉（輸入程式本身的錯）、
旁白與程式不符、`program_input` 殘留垃圾、在不會停的行（`#include`、`using`、`int main() {`、單獨 `}`）寫註解、
自創的 `@N` 門檻。`check_lesson.py` 判通過；`score_lesson.py` S=60%（S1=0、S4=0）。

## 實驗二：變體比較（6 題 × 2 次 = 12 份／變體）

| 變體 | 通過 G | 第一次就過 | S 平均 | 空內容 | 主要失敗 |
|---|---|---|---|---|---|
| baseline（思考開啟，現行） | 4/12 | 4/12 | 30.3 | **7** | `finish_reason=length`：思考用光 16384 tokens |
| nothink（`chat_template_kwargs.thinking=false`） | 2/12 | 2/12 | 16.7 | 0 | G5×10、G3×3、G1×2 |
| np（nothink + 常見錯誤清單） | 3/12 | 3/12 | 25.0 | 0 | 同上，清單無可見效果 |
| **nr（nothink + 修正一輪）** | **10/12** | 4/12 | **76.2** | 0 | G5×2 |
| npr（nothink + 清單 + 修正） | 10/12 | 2/12 | 75.2 | 0 | G1×1、G5×1 |

原始彙總：`raw-task-outputs/1…5`。**逐份生成的 `.cpp` 已遺失**（容器重建時 `/tmp/eval` 被清掉），只剩彙總。

### 診斷（為何 baseline 有 7 份空內容）

| 題 | finish_reason | 思考字元 | 內容字元 | completion_tokens |
|---|---|---|---|---|
| string | length | 53,392 | 0 | 16,384 |
| vector | length | 56,319 | 0 | 16,384 |
| recursion | stop | 40,434 | 2,528 | 14,909 |

prompt_tokens ≈ 22,100–22,250。耗時 492–566 秒。（`raw-task-outputs/2`）

### 關閉思考的參數探測（`raw-task-outputs/3`）

| 寫法 | 思考字元 | 結果 |
|---|---|---|
| 預設 | 215 | — |
| `chat_template_kwargs.thinking=false` | 0 | 有效 |
| `chat_template_kwargs.enable_thinking=false` | 0 | 有效 |
| `thinking.type=disabled` | 0 | 有效 |
| `reasoning_effort=low` | 217 | 無效（被忽略） |

另：即使只回一個單字的請求也要 106–144 秒（固定開銷，與輸出長度無關）。

## 實驗三：上線版端到端（真正的 `/api/generate_lesson`）

上線版 = nothink + 修一輪 + 確定性移除引用剛宣告變數的 `{x}` + 補回被刪的 `//` 註解 + 退回第一份的保護。
拋棄式資料庫、測試帳號、真模型。

- **第一輪（`raw-task-outputs/6`）：6 個並行 → 6/18 次回 429（NVIDIA 限流），結果作廢。**
  有效 12 次中通過 G 9/12；失敗是 dp×2（G1：模型刪掉開頭 `//` 註解）、string×1（G3）。
  這輪之後才加了「補回被刪註解」與 429 友善訊息。
- **第二輪（最終，`raw-task-outputs/7`、`route-eval-final/`）：3 個並行，18/18 通過 G。**

| 題 | 三次 S 分數 | 修正回合 | 耗時（秒） | 扣分原因 |
|---|---|---|---|---|
| dp | 100 / 100 / 100 | 0/3 | 123–155 | 無（三次都補回被刪的註解） |
| vector | 100 / 100 / 88 | 1/3 | 136–286 | 第三次 S1 |
| recursion | 90 / 90 / 90 | 3/3 | 280–284 | S6 覆蓋率 88%（漏 2 行） |
| for | 88 / 88 / 88 | 3/3 | 364–367 | S1：1 行 |
| while | 88 / 88 / 88 | 3/3 | 307–309 | S1：1 行 |
| string | 70 / 70 / 70 | 3/3 | 272–300 | S1：2 行、S4：讀資料行有旁白、S6：漏 1 行 |

彙總：通過 G 18/18；第一次就乾淨 5/18；需要修正回合 13/18；有警告 4/18；
S 平均 88.7、標準差 9.7（幾乎全是題目間差異，同題三次高度一致）；平均耗時 261 秒。

## 限制（寫論文時要如實交代）

1. 樣本小：6 題 × 2–3 次；變體間差 1–2 份屬雜訊（例如 np vs nothink）。10/12 對 4/12 的落差才算有信號。
2. S 是啟發式靜態判斷，不是 GDB 實跑；沒有量「按 Run 真的自動播完」。
3. **教學品質（Q）未量測**；G 全過只代表結構可播。
4. 修正回合的觸發條件是 G 門檻，不含 S1–S6，所以 string 這類「結構小毛病」不會被修。
5. 早期實驗的逐份輸出遺失，只留彙總；第一輪端到端受 429 污染。
6. 考題是作者自己的教案、輸入去掉註解後的程式；題型偏向作者慣用風格。
7. 評分腳本在對人工教案校準時修過三個誤判（`return x;`、`std::cin >> a;`、呼叫行 `@2`），
   實驗二的 baseline/nothink 等是在該校準之後跑的。
8. 執行環境：NVIDIA 端點、2026-10-26；限流與模型行為可能隨時間改變。

## 重現

```
docker cp scripts/score_lesson.py <容器>:/app/scripts/
docker exec <容器> mkdir -p /app/experiments_eval
docker cp experiments/lesson-gen-eval/run_eval.py <容器>:/app/experiments_eval/
docker cp experiments/lesson-gen-eval/run_route_eval.py <容器>:/app/experiments_eval/
docker exec -d <容器> sh -c 'cd /app && python experiments_eval/run_eval.py nothink nr --reps 2 \
    --model deepseek-ai/deepseek-v4.1-flash > /tmp/eval.log 2>&1'
docker exec -d <容器> sh -c 'cd /app && python experiments_eval/run_route_eval.py --reps 3 --workers 3 > /tmp/route.log 2>&1'
```

相關 commit：`ccda3662`（prompt 規則 10/11 + code_unchanged）、`e1af6a7b`（評分腳本）、
`3a5ecc8c`（預設模型）、`cc21baae`（關閉思考 + 修一輪 + 確定性移除）、`8963dba3`（補回註解 + 429）。
