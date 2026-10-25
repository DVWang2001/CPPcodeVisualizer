"""教學頁課程產生器 v2。

每一課是一份完整的 C++ 程式（//@ 註解直接寫在程式裡）。產生器會檢查：
  * 每個「會被執行」的行都必須帶 //@（否則自動播放會在那一行停住），
    刻意跳過的行（被 [continue] 跳過、類別成員宣告…）要寫 /*skip*/ 標記；
  * `bare=True` 的課（綜合實作）不檢查。
輸出：<OUT>/tutorial_<id>.json（v2 bundle）與 <OUT>/chapters.json。
"""
import json, os, re, sys

OUT = sys.argv[1]
os.makedirs(OUT, exist_ok=True)

CONTROL = re.compile(r"^(if|for|while|switch|else|return|catch|do)\b")
FUNC_HEADER = re.compile(r"^[\w:<>,*&\s~]+\([^;]*\)\s*(const)?\s*\{?$")


def code_of(line):
    i = line.find("//@")
    return (line if i < 0 else line[:i]).strip()


def is_runnable(line):
    c = code_of(line).replace("/*skip*/", "").strip()
    if not c:
        return False
    if c.startswith("#") or c.startswith("//") or c.startswith("/*"):
        return False
    if re.match(r"^using\b", c):
        return False
    if re.match(r"^[{}();\s]*$", c):
        return False
    if re.match(r"^\}?\s*else\s*\{?$", c):
        return False
    if re.match(r"^(class|struct)\b", c) or re.match(r"^(public|private|protected):$", c):
        return False
    if FUNC_HEADER.match(c) and not CONTROL.match(c):
        return False
    return True


def check(pid, src, bare):
    if bare:
        return
    for n, line in enumerate(src.split("\n"), 1):
        if "/*skip*/" in line:
            continue
        if is_runnable(line) and "//@" not in line:
            raise SystemExit("lesson %s line %d is runnable but has no //@ : %s" % (pid, n, line.strip()))


def finish(src):
    return re.sub(r"[ ]*/\*skip\*/", "", src)


INC = "#include <iostream>\n"

# ---------------------------------------------------------------- 迴圈程式（guide / tts 共用）
HEAD = INC + "using namespace std;\n\nint main() {   //@ @layout open:visualizer\n"


def prog(for_note="", body_note=""):
    return (
        HEAD
        + "    int sum = 0;   //@ @tts [next] 先準備 sum，從 0 開始\n"
        + "    for (int i = 1; i <= 3; i++) {   //@ " + (for_note or "@tts [next] 進入迴圈 | @2 [next] 看看要不要再來一圈") + "\n"
        + "        sum += i;   //@ " + (body_note or "@tts [next] 第 {i} 圈，加進 sum") + "\n"
        + "    }\n"
        + "    cout << sum << endl;   //@ @tts [next] 全部跑完，總和是 {sum}\n"
        + "    return 0;   //@ @tts [continue] 程式結束\n"
        + "}\n"
    )


def simple(body, includes="", layout="open:visualizer"):
    """一個 main：body 是縮排好的程式行（含 //@），自動補 include / main 標頭。"""
    return INC + includes + "using namespace std;\n\nint main() {   //@ @layout " + layout + "\n" + body + "}\n"


L = []


def lesson(pid, feat, title, goal, steps, tip, src, bp=None, bare=False):
    L.append(dict(id=pid, feat=feat, title=title, goal=goal, steps=steps, tip=tip, src=src, bp=bp, bare=bare))


# ================================================================ guide：迴圈行為
lesson("g1", "guide", "guide 只放變數",
       "迴圈每跑一圈，`sum += i` 就被停到一次。guide 只寫變數，值會顯示在右邊的程式追蹤表；要說明的話交給 `@tts`。",
       ["在 `sum += i` 那行按一次 **Enter**，直接跑到這裡。",
        "右邊程式追蹤表出現這一次的 `i`，下面字幕念出旁白。",
        "把 `{i}` 換成 `{sum}`，再按 **Enter**，看顯示的值怎麼換。"],
       "第一行的 `@layout open:visualizer` 讓程式追蹤表自動展開，不用自己去找。",
       prog(body_note="@guide {i} @tts [next] 迴圈第 {i} 圈"))
lesson("g3", "guide", "guide 逐圈累積",
       "在迴圈裡的行連按 Enter，一次進入一圈，程式追蹤表每次多一列，看變數怎麼一圈一圈變化。",
       ["在 `sum += i` 那行按 **Enter**，跑到第 1 次進入。",
        "再按 **Enter**，進到第 2 次、第 3 次；第 3 次之後再按，回到第 1 次。",
        "把 `{sum}` 換成 `{i}`，按 **Enter** 看表裡的值怎麼換。"],
       "改過任何一行程式，再按 Enter 會從第 1 次重來。",
       prog(body_note="@guide {sum} @tts [next] sum 現在是 {sum}"))

# ================================================================ tts：旁白
lesson("t1", "tts", "tts 念出變數",
       "`@tts` 會念出並顯示字幕，`{}` 裡的變數會被代入實際的值。",
       ["在 `sum += i` 那行按 **Enter**，聽旁白念出 `i` 和 `sum`。",
        "把 `sum` 那段刪掉，只留 `i`，再按 **Enter**。"],
       "旁白寫的是說明，變數的值放在 `{}` 裡。",
       prog(body_note="@tts [next] 現在 i 是 {i}，sum 是 {sum}"))
lesson("t2", "tts", "tts 停頓",
       "`[pause:N]` 讓語音停 N 秒，給學生一點思考時間。",
       ["在 `sum += i` 那行按 **Enter**，聽旁白中間的停頓。",
        "把 `[pause:1]` 改成 `[pause:3]`，再按 **Enter** 比較差別。"],
       "`[wait:N]` 的效果相同。",
       prog(body_note="@tts [next] i 是 {i}。[pause:1] 接下來把它加進 sum"))
lesson("t3", "tts", "tts 多次拜訪",
       "`| @2` 之後的話，從第 2 次停到這一行才會說，同一行可以每次講不同的話。",
       ["在 `for` 那行按 **Enter**：第 1 次進入說「開始迴圈」。",
        "再按 **Enter**：第 2 次進入換成另一句。",
        "把 `@2` 改成 `@3`，再按 **Enter** 試試。"],
       "這是「越講越簡短」的基本寫法。",
       prog(for_note="@tts [next] 開始迴圈 | @2 [next] 又回到迴圈開頭"))
lesson("t4", "tts", "tts 自動播放",
       "每一行開頭的 `[next]` 讓旁白念完自動執行下一行，全部串起來就能從頭播到尾。",
       ["按上方的 **從頭**，看旁白一行接一行自動播到結束。",
        "把 `sum += i` 那行的 `[next]` 刪掉，再按 **從頭**，看自動播放停在哪一行。"],
       "最後一行用 `[continue]`，讓程式跑到結束。",
       prog())
lesson("t5", "tts", "tts 自訂發音",
       "語音有時會把字唸錯。在字後面加 `[正確的字]`，語音就改唸括號裡的字，字幕仍顯示原字。",
       ["按上方的 **從頭**，聽「更新」的「更」怎麼念，同時看字幕。",
        "把 `更[耕]新` 的 `[耕]` 刪掉，再按 **從頭**，比較念法的差別。"],
       "括號裡只能放中文字；`arr[i]` 這種索引不會被當成發音標記。",
       simple(
           "    int x = 5;   //@ @tts [next] 先把 x 設成五\n"
           "    x = x + 1;   //@ @guide {x} @tts [next] 接著更[耕]新 x，把它加一\n"
           "    cout << x << endl;   //@ @guide {x} @tts [next] x 變成 {x}\n"
           "    return 0;   //@ @tts [continue] 程式結束\n"))
lesson("t6", "tts", "tts 調整語速",
       "`[speed:N]` 調整朗讀速度，N 在 0.1 到 4 之間，1.0 是正常；設定會一直持續到下次更改。",
       ["按上方的 **從頭**，聽三句話的速度一句比一句不同。",
        "把第一句的 `[speed:0.7]` 改成 `[speed:1.5]`，再按 **從頭**。"],
       "速度標記只是指令，不會出現在字幕裡。",
       simple(
           "    int x = 3;   //@ @tts [speed:0.7] [next] 這一句講得比較慢\n"
           "    x = x + 1;   //@ @guide {x} @tts [speed:1.6] [next] 這一句講得比較快\n"
           "    cout << x << endl;   //@ @guide {x} @tts [speed:1.0] [next] 速度恢復正常，x 是 {x}\n"
           "    return 0;   //@ @tts [continue] 程式結束\n"))

# ================================================================ 自動播放
lesson("a1", "auto", "自動播放：進入與跳出函式",
       "`[step-in]` 讓旁白念完自動進到函式裡面，`[step-out]` 讓它自動跳回呼叫的地方。",
       ["按上方的 **從頭**，看它自己走進 `square`，再自己走出來。",
        "把呼叫那一行的 `[step-in]` 改成 `[next]`，再按 **從頭**，看它還會不會進到函式裡。"],
       "函式裡的每一行也要有旁白，自動播放才不會卡在那裡。",
       INC + "using namespace std;\n\n"
       "int square(int x) {\n"
       "    return x * x;   //@ @guide {x} @tts [step-out] 這裡把 x 乘上 x，然後跳回呼叫它的地方\n"
       "}\n\n"
       "int main() {   //@ @layout open:visualizer\n"
       "    int a = 4;   //@ @tts [next] 先準備 a，值是四\n"
       "    int b = square(a);   //@ @tts [step-in] 呼叫 square，進到函式裡面看看 | @2 [next] 回到呼叫的地方，結果存進 b\n"
       "    cout << b << endl;   //@ @guide {b} @tts [next] b 現在是 {b}\n"
       "    return 0;   //@ @tts [continue] 程式結束\n"
       "}\n")
lesson("a2", "auto", "自動播放：直接跳過",
       "`[continue]` 讓程式一路跑到下一個斷點，不重要的迴圈就不用一圈一圈講。",
       ["按上方的 **從頭**，看它講完第一句就直接跳過整個迴圈。",
        "把 `for` 那行的 `[continue]` 改成 `[next]`，再按 **從頭**，比較差別。"],
       "斷點在 `cout` 那一行（紅點）。`[continue]` 會停在那裡。",
       simple(
           "    int sum = 0;   //@ @tts [next] 先準備 sum\n"
           "    for (int i = 1; i <= 5; i++) {   //@ @tts [continue] 這個迴圈不是重點，直接跳到下一個斷點\n"
           "        sum += i;   /*skip*/\n"
           "    }\n"
           "    cout << sum << endl;   //@ @guide {sum} @tts [next] 迴圈全部跑完，sum 是 {sum}\n"
           "    return 0;   //@ @tts [continue] 程式結束\n"),
       bp=["int sum = 0", "cout << sum"])
lesson("a3", "auto", "自動播放：快轉到第 N 次",
       "`[fast @N]` 讓程式無聲快轉，到這一行的第 N 次才開始講話。",
       ["按上方的 **從頭**，看它很快跳到第 8 圈才開口。",
        "把 `@8` 改成 `@3`，再按 **從頭**。"],
       "只有在自動播放開著時才會快轉。快轉的目標次數要在進入迴圈前就決定。",
       simple(
           "    int sum = 0;   //@ @tts [next] 先準備 sum\n"
           "    for (int i = 1; i <= 8; i++) {   //@ @tts [next] 進入迴圈 | @2 [next] 下一圈\n"
           "        sum += i;   //@ @guide {sum} @tts [fast @8] 前面七圈都快轉過去了，這是第八圈，sum 是 {sum}\n"
           "    }\n"
           "    cout << sum << endl;   //@ @tts [next] 全部跑完，總和是 {sum}\n"
           "    return 0;   //@ @tts [continue] 程式結束\n"))

# ================================================================ layout：面板與動畫
lesson("l1", "layout", "layout：開關面板",
       "`@layout open:面板` 和 `close:面板` 讓每一行自己決定要看哪些面板，學生不用自己找。",
       ["按上方的 **從頭**，看程式追蹤表先出現，到 `vector` 那行換成容器面板。",
        "把 `open:container close:visualizer` 換成 `open:visualizer`，再按 **從頭**。"],
       "面板名稱：`visualizer`（程式追蹤表）、`container`（容器）、`callgraph`（呼叫圖）、`memory_watch`（記憶體）。",
       simple(
           "    int n = 3;   //@ @tts [next] 先決定要放幾個數字，現在只開程式追蹤表\n"
           "    vector<int> v;   //@ @tts [next] 接下來要看容器，所以換成容器面板 @layout open:container close:visualizer\n"
           "    for (int i = 1; i <= n; i++) {   //@ @tts [next] 開始放數字 | @2 [next] 下一個\n"
           "        v.push_back(i * i);   //@ @guide {v} @tts [next] 放進第 {i} 個平方數\n"
           "    }\n"
           "    cout << v.size() << endl;   //@ @guide {v} @tts [next] 全部放好了\n"
           "    return 0;   //@ @tts [continue] 程式結束\n",
           includes="#include <vector>\n", layout="open:visualizer"))
lesson("l2", "layout", "layout：格子跳一下 pop",
       "`@layout pop:容器` 讓這一行高亮的格子放大再縮小，提醒學生「看這一格」。",
       ["在 `arr[i] = arr[i] * 2` 那行按 **Enter**，看被標橘色的那一格跳一下。",
        "連按 **Enter** 進到下一格，每一格都會跳。",
        "把 `pop:arr` 刪掉再按 **Enter**，比較差別。"],
       "`pop:` 只在寫了它的那一行生效，不會延續到下一行。",
       simple(
           "    vector<int> arr = {3, 1, 4};   //@ @tts [next] 準備一個有三個數字的陣列\n"
           "    for (int i = 0; i < 3; i++) {   //@ @tts [next] 一格一格處理 | @2 [next] 看看還有沒有下一格\n"
           "        arr[i] = arr[i] * 2;   //@ @guide {arr[i]:orange} @tts [next] 第 {i} 格要乘以二 @layout pop:arr\n"
           "    }\n"
           "    cout << arr[0] << endl;   //@ @guide {arr} @tts [next] 全部乘完了\n"
           "    return 0;   //@ @tts [continue] 程式結束\n",
           includes="#include <vector>\n", layout="open:container"))
lesson("l3", "layout", "layout：兩格飛進來 pull",
       "`@layout pull:` 讓兩個來源格的數字飛進目標格，表達「這一格是由那兩格算出來的」。",
       ["按上方的 **從頭**，看上面和左邊兩格的數字飛進右下角那一格。",
        "把 `orange,lime->lightblue` 的順序對調，再按 **從頭**，看看會發生什麼。"],
       "顏色要和 `@guide` 裡標的顏色一致；`pull:` 目前只支援兩數相加。",
       simple(
           "    vector<vector<int>> dp(2, vector<int>(3, 1));   //@ @tts [next] 準備一張兩列三欄的表，全部填一\n"
           "    int up = dp[0][1];   //@ @guide {dp[0][1]:orange} @tts [next] 先看上面那一格 @layout pop:dp:orange\n"
           "    int left = dp[1][0];   //@ @guide {dp[1][0]:lime} @tts [next] 再看左邊那一格 @layout pop:dp:lime\n"
           "    dp[1][1] = up + left;   //@ @guide {dp[1][1]:lightblue} @tts [next] 上面加左邊，就是這一格的答案 @layout pull:dp:orange,lime->lightblue\n"
           "    cout << dp[1][1] << endl;   //@ @guide {dp} @tts [next] 這一格現在是 {dp[1][1]}\n"
           "    return 0;   //@ @tts [continue] 程式結束\n",
           includes="#include <vector>\n", layout="open:container"))
lesson("l4", "layout", "layout：動畫對上旁白 [anim]",
       "旁白很長時，動畫會太早跳。在旁白裡插入 `[anim]`，動畫就等唸到那裡才播。",
       ["按上方的 **從頭**，看格子在唸到「看這一格」時才跳。",
        "把 `[anim]` 移到句子最前面，再按 **從頭**，比較動畫出現的時間。"],
       "沒寫 `[anim]` 就是原本的行為：停到這一行就立刻播。",
       simple(
           "    vector<int> arr = {3, 1, 4};   //@ @tts [next] 準備一個有三個數字的陣列\n"
           "    for (int i = 0; i < 3; i++) {   //@ @tts [next] 一格一格處理 | @2 [next] 看看還有沒有下一格\n"
           "        arr[i] = arr[i] * 2;   //@ @guide {arr[i]:orange} @tts [next] 現在輪到第 {i} 格，先講一句話，[anim]看這一格 @layout pop:arr\n"
           "    }\n"
           "    cout << arr[0] << endl;   //@ @guide {arr} @tts [next] 全部乘完了\n"
           "    return 0;   //@ @tts [continue] 程式結束\n",
           includes="#include <vector>\n", layout="open:container"))

# ================================================================ guide：容器
lesson("c1", "container", "容器：vector",
       "guide 寫 `{v}`，容器面板就畫出 `vector`；放進、拿掉元素的動畫是自動的，不用另外寫。",
       ["按上方的 **從頭**，看元素一個一個淡入，最後一個被拿掉時淡出。",
        "在 `push_back` 那幾行連按 **Enter**，一行一行看。"],
       "`{v}` 顯示的是「這一行執行前」的內容，所以旁白講的是接下來要發生的事。",
       simple(
           "    vector<int> v;   //@ @tts [next] 從空的 vector 開始\n"
           "    v.push_back(3);   //@ @guide {v} @tts [next] 放進三\n"
           "    v.push_back(1);   //@ @guide {v} @tts [next] 再放進一\n"
           "    v.push_back(4);   //@ @guide {v} @tts [next] 再放進四\n"
           "    v.pop_back();   //@ @guide {v} @tts [next] 拿掉最後一個\n"
           "    cout << v.size() << endl;   //@ @guide {v} @tts [next] 現在剩下兩個\n"
           "    return 0;   //@ @tts [continue] 程式結束\n",
           includes="#include <vector>\n", layout="open:container"))
lesson("c2", "container", "容器：stack 與 queue",
       "同樣的 `push` 和 `pop`，`stack` 先進後出、`queue` 先進先出，兩個容器並排看最清楚。",
       ["按上方的 **從頭**，看兩個容器同時放進一二三。",
        "`pop` 之後，比較兩邊被拿掉的是哪一個。"],
       "`pair:s,q` 讓兩個容器並排；要兩個都有資料才會並排。",
       simple(
           "    stack<int> s;   //@ @tts [next] 準備一個 stack\n"
           "    queue<int> q;   //@ @tts [next] 再準備一個 queue\n"
           "    s.push(1);   //@ @guide {s} {q} @tts [next] 兩個都放進一 @layout pair:s,q\n"
           "    q.push(1);   //@ @guide {s} {q} @tts [next] queue 也放進一\n"
           "    s.push(2);   //@ @guide {s} {q} @tts [next] 放進二\n"
           "    q.push(2);   //@ @guide {s} {q} @tts [next] 放進二\n"
           "    s.push(3);   //@ @guide {s} {q} @tts [next] 放進三\n"
           "    q.push(3);   //@ @guide {s} {q} @tts [next] 放進三\n"
           "    s.pop();   //@ @guide {s} {q} @tts [next] stack 拿掉最後放進去的\n"
           "    q.pop();   //@ @guide {s} {q} @tts [next] queue 拿掉最先放進去的\n"
           "    cout << s.size() << q.size() << endl;   //@ @guide {s} {q} @tts [next] 兩邊各剩兩個，但剩下的不一樣\n"
           "    return 0;   //@ @tts [continue] 程式結束\n",
           includes="#include <stack>\n#include <queue>\n", layout="open:container"))
lesson("c3", "container", "容器：set 與紅黑樹",
       "`set` 預設畫成集合。寫 `bst:s`，容器面板就切成紅黑樹，每放進一個數字就看樹怎麼長。",
       ["按上方的 **從頭**，看五個數字依序長成一棵樹。",
        "把 `bst:s` 刪掉，再按 **從頭**，看看換回集合長什麼樣。"],
       "紅色節點是紅，深色是黑；`bh` 是黑色高度。",
       simple(
           "    set<int> s;   //@ @tts [next] 準備一個空的 set\n"
           "    s.insert(5);   //@ @guide {s} @tts [next] 放進五 @layout bst:s\n"
           "    s.insert(3);   //@ @guide {s} @tts [next] 放進三\n"
           "    s.insert(8);   //@ @guide {s} @tts [next] 放進八\n"
           "    s.insert(1);   //@ @guide {s} @tts [next] 放進一\n"
           "    s.insert(4);   //@ @guide {s} @tts [next] 放進四\n"
           "    cout << s.size() << endl;   //@ @guide {s} @tts [next] 一共五個數字\n"
           "    return 0;   //@ @tts [continue] 程式結束\n",
           includes="#include <set>\n", layout="open:container"))
lesson("c4", "container", "容器：map",
       "`map` 用表格顯示每一組 key 和 value；同一個 key 再放一次，值會被蓋掉。",
       ["按上方的 **從頭**，看三個 key 依序出現。",
        "留意最後一行改的是哪一個 key。"],
       "`map` 也可以像 `set` 一樣用 `bst:m` 切成紅黑樹。",
       simple(
           "    map<string, int> m;   //@ @tts [next] 準備一個空的 map\n"
           "    m[\"apple\"] = 3;   //@ @guide {m} @tts [next] 放進蘋果，數量三\n"
           "    m[\"pear\"] = 5;   //@ @guide {m} @tts [next] 放進梨子，數量五\n"
           "    m[\"fig\"] = 2;   //@ @guide {m} @tts [next] 放進無花果，數量二\n"
           "    m[\"apple\"] = 4;   //@ @guide {m} @tts [next] 蘋果已經有了，這一行會把它改成四\n"
           "    cout << m.size() << endl;   //@ @guide {m} @tts [next] 還是三組，因為蘋果只是被改掉\n"
           "    return 0;   //@ @tts [continue] 程式結束\n",
           includes="#include <map>\n#include <string>\n", layout="open:container"))
lesson("c5", "container", "容器：二維陣列與迷宮",
       "二維的 `vector` 會自動畫成格子。寫 `maze:grid`，就換成迷宮的配色。",
       ["按上方的 **從頭**，看牆（一）一個一個築起來。",
        "把 `maze:grid` 刪掉，再按 **從頭**，比較格子的樣子。"],
       "`{grid[r][c]:orange}` 可以高亮一格，索引不能再包含 `[ ]`。",
       simple(
           "    vector<vector<int>> grid(3, vector<int>(3, 0));   //@ @tts [next] 準備一張三乘三的地圖，全部是空地 @layout maze:grid\n"
           "    grid[1][1] = 1;   //@ @guide {grid} {grid[1][1]:orange} @tts [next] 在正中間築一道牆\n"
           "    grid[0][2] = 1;   //@ @guide {grid} {grid[0][2]:orange} @tts [next] 右上角也築一道牆\n"
           "    grid[2][0] = 2;   //@ @guide {grid} {grid[2][0]:lime} @tts [next] 左下角標成二，當作終點\n"
           "    cout << grid[1][1] << endl;   //@ @guide {grid} @tts [next] 地圖完成了\n"
           "    return 0;   //@ @tts [continue] 程式結束\n",
           includes="#include <vector>\n", layout="open:container"))
lesson("c6", "container", "容器：標出索引與交換",
       "`{a[i]}` 和 `{a[j]:lightblue}` 可以標出兩個索引；`swap` 兩格會真的平移過去交換。",
       ["在 `swap` 那行按 **Enter**，看兩個被標色的格子。",
        "按上方的 **從頭**，看兩次交換的動畫。"],
       "交換的動畫是自動的，不用寫任何 `@layout`。",
       simple(
           "    vector<int> a = {3, 1, 2};   //@ @tts [next] 準備一個陣列\n"
           "    int i = 0;   //@ @tts [next] 先指向第零格\n"
           "    int j = 1;   //@ @tts [next] 另一個指向第一格\n"
           "    swap(a[i], a[j]);   //@ @guide {a[i]:orange} {a[j]:lightblue} @tts [next] 把這兩格交換\n"
           "    j = 2;   //@ @guide {a} @tts [next] 第二次，換成跟第二格交換\n"
           "    swap(a[i], a[j]);   //@ @guide {a[i]:orange} {a[j]:lightblue} @tts [next] 再交換一次\n"
           "    cout << a[0] << endl;   //@ @guide {a} @tts [next] 最小的跑到最前面了\n"
           "    return 0;   //@ @tts [continue] 程式結束\n",
           includes="#include <vector>\n#include <algorithm>\n", layout="open:container"))

# ================================================================ 呼叫圖
lesson("r1", "callgraph", "呼叫圖：遞迴與標籤",
       "遞迴的每一層會變成呼叫圖上的一個節點。guide 開頭加 `[標籤#顏色]`，節點上就顯示那段文字——呼叫圖是少數需要把話寫清楚的地方。",
       ["按上方的 **從頭**，看呼叫圖往下長三層，再一層一層回來。",
        "把 `[基底#green]` 的顏色改成 `red`，再按 **從頭**。"],
       "遞迴要把回傳值先存進名為 `result` 的變數，節點上才會顯示 `⇒ 值`。斷點放在函式的第一個可執行行。",
       INC + "using namespace std;\n\n"
       "int fact(int n) {\n"
       "    int result;   //@ @guide [進入#blue] n={n} @tts [next] 進到階乘，n 是 {n}\n"
       "    if (n <= 1) {   //@ @guide [判斷#gray] n={n} @tts [next] 看看是不是到底了\n"
       "        result = 1;   //@ @guide [基底#green] 到底了 @tts [next] 到底了，答案是一\n"
       "        return result;   //@ @guide [回傳#green] 回傳 {result} ← 基底 @tts [next] 把一傳回去\n"
       "    }\n"
       "    int sub = fact(n - 1);   //@ @guide [遞迴呼叫#red] 處理 n-1 @tts [step-in] 處理更小的子問題\n"
       "    result = n * sub;   //@ @guide [合併#purple] {n} × {sub} @tts [next] 把子問題的答案乘上自己\n"
       "    return result;   //@ @guide [回傳#blue] 回傳 {result} ← {n} × {sub} @tts [next] 把答案傳回去\n"
       "}   //@ @tts [next] 這一層結束，回到上一層\n\n"
       "int main() {   //@ @layout open:callgraph\n"
       "    int r = fact(3);   //@ @tts [step-in] 呼叫三的階乘 | @2 [next] 全部回來了\n"
       "    cout << r << endl;   //@ @guide {r} @tts [next] 答案是 {r}\n"
       "    return 0;   //@ @tts [continue] 程式結束\n"
       "}\n",
       bp=["int result;", "int r = fact(3)"])

# ================================================================ UML
lesson("u1", "uml", "UML：一個物件",
       "`@guide uml:變數名` 把那個物件畫成 UML 方框，每個欄位旁邊是它現在的值。",
       ["按上方的 **從頭**，看 `p` 的方框出現，欄位值跟著程式變。",
        "把 `uml:p` 換成 `uml:q`（再多宣告一個物件），看兩個方框。"],
       "UML 面板的名稱是 `uml_visualizer`，要用 `open:uml_visualizer` 打開。",
       INC + "using namespace std;\n\n"
       "class Point {\n"
       "public:\n"
       "    int x;   /*skip*/\n"
       "    int y;   /*skip*/\n"
       "    Point(int a, int b) { x = a; y = b; }   /*skip*/\n"
       "};\n\n"
       "int main() {   //@ @layout open:uml_visualizer\n"
       "    Point p(3, 4);   //@ @tts [next] 建立一個點，座標是三和四\n"
       "    cout << p.x << endl;   //@ @guide uml:p @tts [next] 這是 p 現在的樣子\n"
       "    p.x = 10;   //@ @guide uml:p @tts [next] 把 x 改成十\n"
       "    cout << p.x << endl;   //@ @guide uml:p @tts [next] x 變成十了\n"
       "    return 0;   //@ @tts [continue] 程式結束\n"
       "}\n")
lesson("u2", "uml", "UML：呼叫成員函式",
       "物件的欄位會隨著成員函式一次一次改變，方框裡的值逐步更新。",
       ["按上方的 **從頭**，看 `count` 一次加二、一次加三。",
        "在 `add` 那兩行連按 **Enter**，一行一行看方框變化。"],
       "`[next]` 會跨過函式呼叫；要看函式裡面就用 `[step-in]`。",
       INC + "using namespace std;\n\n"
       "class Counter {\n"
       "public:\n"
       "    int count;   /*skip*/\n"
       "    Counter() { count = 0; }   /*skip*/\n"
       "    void add(int k) { count += k; }   /*skip*/\n"
       "};\n\n"
       "int main() {   //@ @layout open:uml_visualizer\n"
       "    Counter c;   //@ @tts [next] 建立一個計數器\n"
       "    c.add(2);   //@ @guide uml:c @tts [next] 加二\n"
       "    c.add(3);   //@ @guide uml:c @tts [next] 再加三\n"
       "    cout << c.count << endl;   //@ @guide uml:c @tts [next] 現在是五\n"
       "    return 0;   //@ @tts [continue] 程式結束\n"
       "}\n")

# ================================================================ 綜合實作
lesson("h1", "final", "綜合：自己加註解",
       "這份程式沒有任何 `//@`。請你自己加上 guide、tts、layout，做成一課會自己講的教案。",
       ["在 `sum += i` 那行行尾寫 `//@ @guide {sum} @tts [next] sum 現在是 {sum}`，按 **Enter** 看效果。",
        "在每個會被執行的行都加上 `@tts [next]`，最後一行用 `[continue]`。",
        "在第一行加上 `@layout open:visualizer`，再按 **從頭**，看它能不能從頭播到尾。"],
       "改得不順時，回頭看「tts 自動播放」那一課，它是一份完整的範例。",
       INC + "using namespace std;\n\n"
       "int main() {\n"
       "    int sum = 0;\n"
       "    for (int i = 1; i <= 3; i++) {\n"
       "        sum += i;\n"
       "    }\n"
       "    cout << sum << endl;\n"
       "    return 0;\n"
       "}\n",
       bare=True)

NAMES = [
    ("guide", "guide：迴圈行為"),
    ("tts", "tts：旁白"),
    ("auto", "自動播放"),
    ("layout", "layout：面板與動畫"),
    ("container", "guide：容器"),
    ("callgraph", "guide：呼叫圖"),
    ("uml", "UML 物件圖"),
    ("final", "綜合實作"),
]


def first_main_runnable(lines):
    inmain = False
    for n, l in enumerate(lines, 1):
        if re.match(r"^\s*int\s+main\s*\(", code_of(l)):
            inmain = True
            continue
        if inmain and is_runnable(l):
            return n
    return 1


feats = {}
for ls in L:
    check(ls["id"], ls["src"], ls["bare"])
    src = finish(ls["src"])
    lines = src.split("\n")
    bps = []
    if ls["bp"]:
        for sub in ls["bp"]:
            bps.append(next(i + 1 for i, l in enumerate(lines) if sub in l))
    else:
        bps.append(first_main_runnable(lines))
    bundle = {
        "version": "2.0",
        "fullname_to_render": "tutorial_%s.cpp" % ls["id"],
        "source_code": src,
        "breakpoints": [{"line": str(n), "is_normal_breakpoint": True} for n in bps],
        "program_input": "",
    }
    fn = "tutorial_%s.json" % ls["id"]
    with open(os.path.join(OUT, fn), "w", encoding="utf-8") as f:
        json.dump(bundle, f, ensure_ascii=False, indent=2)
    feats.setdefault(ls["feat"], []).append(
        {"id": ls["id"], "title": ls["title"], "goal": ls["goal"], "steps": ls["steps"], "tip": ls["tip"], "file": fn})

chapters = {"features": [{"id": k, "title": t, "projects": feats[k]} for k, t in NAMES if k in feats]}
with open(os.path.join(OUT, "chapters.json"), "w", encoding="utf-8") as f:
    json.dump(chapters, f, ensure_ascii=False, indent=2)
print("ok", len(L), "lessons")
