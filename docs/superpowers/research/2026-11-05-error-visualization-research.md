# 錯誤視覺化：文獻與典型錯誤彙整（2026-11-05）

目的：確認「錯誤視覺化」是否已有研究可模仿，並收集學生常犯的 C/C++ 錯誤典型，作為教案素材。
限制：多數來源只取得摘要或書目資訊，未逐篇讀全文；標註「未驗證」者不可直接引用數字。

## A. 相關研究（可模仿的設計）

| 研究 / 工具 | 年份 | 重點 | 對本專案的啟示 |
|---|---|---|---|
| OGRE（Milne & Rowe），*Education and Information Technologies* 9(3) | 2004 | 3D 互動呈現物件在記憶體中的關係；報告 C++ 記憶體主題理解有明顯提升 | 記憶體關係視覺化有實證支持（本專案的 UML / 容器視覺化方向相符） |
| Python Tutor（Guo, SIGCSE 2013）C/C++ 模式 | 2013– | 逐步執行、堆疊/堆積視覺化；C/C++ 模式以 Valgrind 偵測越界與未初始化記憶體 | **最直接的競品**。它已經能「視覺化」越界，本專案的差異應放在「右側欄解釋為什麼錯」與真實 GDB |
| Adcock et al., "Which pointer errors do students make?" SIGCSE 2007 | 2007 | 指標操作的模型與分類；即時回報指標錯誤（null 解參考、已刪除指標解參考、洩漏） | 指標錯誤分類可直接當案例清單的骨架 |
| Sasano, EAI BICT 2015（ACM 2016） | 2015 | 以 GDB 為後端視覺化 stack 上的 return address 被覆寫（紅/黃/藍著色） | 用 GDB 驅動的錯誤視覺化有先例，與本專案架構相近 |
| Michigan Tech VACCS / IR window（Shene 等） | 約 2015 | 以視覺化教整數表示、型別轉換與整數溢位 | 整數溢位的視覺化教學有先例，可模仿其「位元表示」呈現 |
| SecureCVisual（Michigan Tech） | — | 視覺化 process address space，教安全編碼 | 位址空間視圖可用於超界案例 |
| dcc（UNSW, SIGCSE 2023） | 2023 | 偵測 C 的 out-of-bounds、未初始化、null 等，給白話錯誤訊息 | 錯誤訊息文案可參考其寫法 |
| Enhanced compiler error messages（Becker 等；Pettit 等 SIGCSE 2017；中國 7 年級 Python 研究） | 2016–2021 | 增強錯誤訊息的效果**不穩定**：Becker 2017 結論為「inconclusive」；中國 7 年級研究顯示增強訊息組錯誤率反而較高（27.1% vs 23.2%） | **設計警示**：只放文字解釋不夠，應搭配視覺化與「先預測再看結果」的互動，否則效果不明顯 |
| PointerViz（novice 指標視覺化） | — | 指出指標視覺化多半在執行期，編譯前較少 | 本專案已是執行期，此點不構成缺口 |

**結論**：「用視覺化教 C/C++ 記憶體與指標錯誤」已有研究與工具（OGRE、Python Tutor、Sasano、dcc）。
「整數溢位 + 指標超界 + 懸空指標，同時以真實 GDB 執行並在側欄解釋原因」這個組合，我沒有找到完全相同的工具。
→ 依你的指示：**有研究就模仿**，所以採用上表的做法（記憶體圖 + GDB 執行 + 白話錯誤說明），再補上它們沒有的部分。

## B. 典型錯誤清單（收集自網路與文獻）

### B1. 有實證來源的錯誤分布

- **Alzahrani, Vahid, Edgcomb（ASEE 2018/2019）**：80 人 C++ 課程、78 題自動評分。卡關率 10–15%。最容易卡關的主題：巢狀迴圈、`else if` 與多個 `if` 的差異、隨機範圍、輸入/輸出、for 迴圈、`vector` 索引、否定的迴圈條件、布林運算式。
  - 注意：作者之一隸屬 zyBooks（平台提供方），請留意利益關係。
- **Kaczorowska（JCSI 2020）**：43 位 IT 學生，錯誤分類含語法錯誤（缺分號、參數數量錯、括號不平衡）；**記憶體管理是最明顯的問題**。（全文 PDF 無法解析，分類細節未驗證。）
- **Pettit, Homer, Gee（SIGCSE 2017）**：Athene 系統的 C++ 編譯錯誤頻率統計。排名表未能取得，需讀全文（core.ac.uk 版本）。

### B2. 記憶體與指標（最相關，優先納入）

- 解參考空指標（null dereference）
- 解參考已釋放／懸空指標（use-after-free，delete 後仍使用）
- 重複 delete（double free）
- 忘記 delete 造成洩漏（Adcock 分類）
- 未初始化指標或變數（dcc 與 Linux 的 zero-page 差異：未初始化常「剛好正確」，容易誤導）
- 陣列/`vector` 索引越界（dcc 示例：`int [5]` 存取 index 5）
- 指標算術越界
- 函式回傳區域變數的參考或指標（undefined behavior）
- 淺拷貝（shallow copy）導致兩個物件 delete 同一塊記憶體（三法則問題）

### B3. 數值與型別

- 有號整數溢位（`INT_MAX + 1`，UB；`unsigned` 則繞回）
- 整數除法截斷、`int` 與 `double` 混用
- 型別轉換錯誤（有號/無號比較）
- 位移運算的未定義行為（負位移、位移量 ≥ 位元寬度）
- 除以零

### B4. 容器與迭代器

- 迭代器失效：`vector` 的 `push_back` 造成重新配置後，舊迭代器或參考失效
- 在範圍 for 迴圈中 `erase`，迭代器失效
- `vector` 的 `at()` 與 `[]` 差異（越界時前者拋例外、後者未定義）

### B5. 控制流與常見邏輯

- 迴圈邊界 off-by-one（`<=` 與 `<`）
- `if` 與 `else if` 的誤用（Alzahrani 排名高）
- 遞迴缺 base case（stack overflow）
- 賦值 `=` 與比較 `==` 混淆
- 分號多打一個導致 `if (x);`

### B6. 語法（較不適合視覺化，列為參考）

- 缺分號、括號不平衡、參數數量錯誤（Kaczorowska、Pettit 的主要類別）。這類錯誤編譯器已會報告，不需要執行期視覺化。

## C. 對設計的建議（供下一步計畫參考）

1. **案例優先順序**：B2 指標/記憶體 + B3 整數溢位，因為有研究與工具背書，且 GDB 能真實重現。B4 迭代器失效次之。B6 不做。
2. **不要只靠文字說明**：增強錯誤訊息的研究效果不穩定。建議每個案例都包含「先預測結果 → 執行 → 視覺化對照 → 白話解釋」的步驟。
3. **與 Python Tutor 的差異**：Python Tutor 已能顯示越界。我們要補的是：(a) 右側欄的「為什麼錯、正確寫法是什麼」；(b) 真實 GDB 執行（非模擬）；(c) 整數溢位的位元層視覺化。
4. **未驗證項目**：Pettit 的錯誤排名、Kaczorowska 的分類次數、Dasigi 的 C++ bug 目錄（只看到書目）。若要引用數字，需先讀全文。

## D. 來源

- ASEE 2018 Alzahrani 等：https://peer.asee.org/29771
- ASEE 2019 Alzahrani 等：https://peer.asee.org/33083
- Kaczorowska, JCSI 2020：https://ph.pollub.pl/index.php/jcsi/article/download/1681/1734/6319
- Pettit 等 SIGCSE 2017（全文）：https://core.ac.uk/download/212852141.pdf
- Adcock 等 SIGCSE 2007：https://www.academia.edu/19815894/Which_pointer_errors_do_students_make
- Milne & Rowe, OGRE 2004：https://doi.org/10.1023/B:EAIT.0000042041.04999.17
- Sasano, EAI 2015：https://eudl.eu/doi/10.4108/eai.3-12-2015.2262495
- Michigan Tech 整數溢位視覺化：https://digitalcommons.mtu.edu/michigantech-p/569 、 https://digitalcommons.mtu.edu/michigantech-p/15852
- SecureCVisual：https://digitalcommons.mtu.edu/michigantech-p/1739
- Python Tutor C/C++：https://pythontutor.com/articles/c-cpp-visualizer.html 、 https://research.google/pubs/online-python-tutor-embeddable-web-based-program-visualization-for-cs-education/
- dcc（COMP1511UNSW）：https://github.com/adamyi/dcc 、 https://cgi.cse.unsw.edu.au/~learn/debugging/modules/dcc/
- Becker 等 2016（Computer Science Education）與 Inconclusive 結果：https://www.aminer.org/pub/599c7b98601a182cd274c8fd/do-enhanced-compiler-error-messages-help-students-results-inconclusive
- 中國 7 年級 EPEM 研究：https://www.frontiersin.org/articles/10.3389/fpsyg.2021.768962
- Trail of Bits C/C++ bug classes：https://trailofbits.github.io/testing-handbook-preview/pr-preview/pr-128/docs/languages/c-cpp/lang-c-cpp-bug-classes/
- 其他（僅作參考，權威性較低）：https://coddy.tech/docs/cpp/undefined-behavior 、 https://andriisonsiadlo.github.io/knowledge-base/docs/programming/cpp/error-handling-and-safety/undefined-behavior
