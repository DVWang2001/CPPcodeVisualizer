// set / multiset 的五種操作：insert、find、lower_bound、upper_bound、erase
// 重點：lower_bound 與 upper_bound 沿路維護一個「候選」（藍色虛線框），
//       這是 find（只看有沒有命中）沒有的概念。
#include <iostream>
#include <set>
using namespace std;

int main() {
    set<int> s;                                 //@ @guide 空集合 s @tts [next] 我們先建立一個空的 set。接下來一個一個插入元素，觀察它怎麼長成一棵二元搜尋樹 @layout sidebar:55 open:container bst:s
    s.insert(5);                                //@ @guide {s} @tts [next] 插入 5。集合是空的，5 直接成為樹根
    s.insert(3);                                //@ @guide {s} @tts [next] 5 已經是樹根了。現在插入 3，從樹根開始比：3 比 5 小，往左邊走
    s.insert(7);                                //@ @guide {s} @tts [next] 3 掛在 5 的左邊。接著插入 7，7 比 5 大，往右邊走
    s.insert(1);                                //@ @guide {s} @tts [next] 插入 1：比 5 小往左走到 3，再比 3 小繼續往左
    s.insert(9);                                //@ @guide {s} @tts [next] 插入 9：比 5 大往右走到 7，再比 7 大繼續往右

    int r1 = *s.lower_bound(3);                 //@ @guide {s}\n找第一個大於等於 3 的元素 @tts [next] 現在看 lower_bound。它要找第一個大於等於 3 的元素。橘色是正在比對的節點，藍色虛線框是目前的候選 [wait:1] 樹根 5 大於等於 3，先記成候選，往左走 [wait:1] 走到 3，剛好相等。相等就是最好的答案了，直接停下來回傳，不用再往下找
    int r2 = *s.lower_bound(4);                 //@ @guide {s}\n找第一個大於等於 4 的元素 @tts [next] 換成找 4。集合裡沒有 4，所以不會有「命中就停」這回事 [wait:1] 樹根 5 大於等於 4，記成候選 [wait:1] 往左走到 3，3 比 4 小不合格，往右走卻沒有節點了。走到底才能確定，答案就是一路留著的候選 5
    int r3 = *s.lower_bound(5);                 //@ @guide {s}\n找第一個大於等於 5 的元素 @tts [next] 這次找 5。第一步就踩在樹根 5 上，相等，立刻停 [wait:1] 只花一步。記住這個畫面，下一行要拿它來對比

    int r4 = *s.upper_bound(5);                 //@ @guide {s}\n找第一個「嚴格大於」5 的元素 @tts [next] upper_bound 要的是嚴格大於 5，所以相等不算數 [wait:1] 走到樹根 5，相等，不合格，直接往右走 —— 上一行的 lower_bound 在這裡就停了，upper_bound 沒有這個出口 [wait:1] 走到 7，7 大於 5，記成候選，往左沒路了。答案是 7

    bool none = (s.lower_bound(99) == s.end()); //@ @guide {s}\n找第一個大於等於 99 的元素 @tts [next] 如果找一個比所有元素都大的 99 呢 [wait:1] 一路往右走到底，藍色虛線框從頭到尾沒出現過，代表候選始終是空的 [wait:1] 沒有任何元素合格，回傳 end。樹下方的字幕會直接告訴你這件事
    bool has4 = (s.find(4) != s.end());         //@ @guide {s}\n對照組：find(4) @tts [next] 最後放一個對照組。find 只問「有沒有這個元素」，全程不需要候選，所以沒有藍色虛線框 [wait:1] 走到底沒找到 4，節點轉紅色。這就是 find 跟 lower_bound 的差別

    s.erase(3);                                 //@ @guide {s} @tts [next] 順帶看 erase。它一樣會走一次比對路徑，找到 3 之後把節點淡出

    multiset<int> ms;                           //@ @guide {s}\n接下來換 multiset @tts [next] 3 已經從樹上消失了。接下來換 multiset，它允許重複的元素，lower_bound 在這裡才真正展現價值 @layout sidebar:55 open:container bst:s,ms
    ms.insert(5);                               //@ @guide {ms} @tts [next] 插入第一個 5，成為樹根
    ms.insert(2);                               //@ @guide {ms} @tts [next] 插入 2，比 5 小，掛在左邊
    ms.insert(5);                               //@ @guide {ms} @tts [next] 插入第二個 5。相等的元素依照規則往右邊掛，所以它會在樹根的右子樹
    ms.insert(8);                               //@ @guide {ms} @tts [next] 插入 8，一路往右
    ms.insert(5);                               //@ @guide {ms} @tts [next] 再插入第三個 5。往右走到第二個 5，還是相等繼續往右，遇到 8 比它大就往左掛

    int r5 = *ms.lower_bound(5);                //@ @guide {ms}\n三個 5 之中，要拿到最左邊那一個 @tts [next] 樹上現在有三個 5。lower_bound 的規定是回傳「第一個」大於等於 5 的位置，也就是中序走訪裡最左邊的那個 5 [wait:1] 第一步就踩在樹根，相等，停 [wait:1] 為什麼可以放心停？因為相等的元素一律往右掛，所以左子樹的值一定全部小於 5，候選不可能再被換掉。它就是最左邊的那個
    int r6 = *ms.upper_bound(5);                //@ @guide {ms}\n跳過整串 5，找第一個大於 5 的 @tts [next] upper_bound 要跳過整串 5 [wait:1] 樹根相等，不合格往右；第二個 5 也相等，繼續往右 [wait:1] 遇到 8，終於大於 5，記成候選，往左走到第三個 5，還是不合格 [wait:1] 走到底，答案是 8。整條路上候選只被設定過一次

    cout << r1 << r2 << r3 << r4 << r5 << r6 << none << has4 << "\n"; //@ @tts [next] 把結果印出來，避免編譯器把這些變數最佳化掉
    return 0;                                   //@ @tts [next] 五種操作都看過了：insert 與 erase 走比對路徑後淡入淡出，find 只看命中，lower_bound 與 upper_bound 沿路維護候選
}                                               //@ @tts [continue] 關鍵差別在於：lower_bound 命中相等就能停，upper_bound 因為要嚴格大於，永遠得走到底
