// 教案：DP 課 ⑤——把算過的記起來（和第 ④ 課並排看）
// 只多了兩件事：算完存進 memo，開頭先查 memo。knap(1, 4) 第二次被問到時直接查表返回、
// 收成一個葉節點，整棵重複子樹被剪掉 —— 這就是 DP。
// 收尾的畫面：memo 這張表和第 ③ 課那張 dp 是同一張表，只是遞迴只填了用得到的那幾格。
#include <iostream>
#include <vector>

int weights[] = {3, 2, 2};   // 和第 ③、④ 課同一組物品
int values[] = {5, 3, 4};
std::vector<std::vector<int>> memo(4, std::vector<int>(7, -1));   // memo[i][w]，-1 ＝ 還沒算過

int knap(int i, int w) {               //@ @layout sidebar:50 open:callgraph,container
    int result;
    if (i == 0) {                      //@ @guide 子問題 knap({i}, {w})\n記憶表目前：{memo} @tts [next] 子問題是前 {i} 件、容量 {w}；先看是不是一件都不能用 | @2 [next] knap 前 {i} 件、容量 {w}
        result = 0;                    //@ @guide [邊界#gray] 一件都不能用，價值 0 @tts [next] 一件都不能用，價值零
        return result;                 //@ @guide 回傳 0 ← 一件都不能用 @tts [next] 把零交回上一層
    }
    if (memo[i][w] >= 0) {             //@ @guide 先查記憶表：knap({i}, {w}) 這一格算過了嗎？\n{memo[i][w]:lightblue} @tts [next] 動手算之前，先查記憶表這一格 | @2 [next] 先查記憶表第 {i} 列第 {w} 行
        result = memo[i][w];           //@ @guide [查表命中#green] 這一格算過了，直接抄\n{memo[i][w]:lime} @tts [next] 命中！這個子問題算過了，直接拿現成的答案，整棵子樹不用再展開一次
        return result;                 //@ @guide 回傳 {result} ← 直接查記憶表 @tts [next] 把查到的 {result} 交回上一層
    }
    int wi = weights[i - 1];           //@ @guide 沒算過，要自己算。第 {i} 件的重量 @tts [next] 沒算過，只好自己算。先拿出第 {i} 件的重量 | @2 [next] 第 {i} 件的重量
    int vi = values[i - 1];            //@ @guide 第 {i} 件：重量 {wi}，接著取它的價值 @tts [next] 這一件重 {wi} | @2 [next] 這一件重 {wi}
    int skip = knap(i - 1, w);         //@ @guide 分支一：不拿第 {i} 件 @tts [step-in] 處理不拿第 {i} 件：容量沒變，少一件可以選
    int take = 0;                      //@ @guide 不拿的答案是 {skip}\n先假設這一件放不下 @tts [next] 不拿是 {skip}，再看拿的話會是多少 | @2 [next] 不拿是 {skip}
    if (wi <= w) {                     //@ @guide 這一件重 {wi}，容量上限 {w} @tts [next] 放得下嗎？重 {wi}，容量 {w} | @2 [next] 重 {wi}，容量 {w}
        int rest = w - wi;             //@ @guide 拿了它，容量剩 {w} 減 {wi} @tts [next] 拿了之後剩下的容量 | @2 [next] 拿了之後剩下的容量
        int sub = knap(i - 1, rest);   //@ @guide 分支二：拿第 {i} 件 → 問容量剩 {rest} 的子問題 @tts [step-in] 處理拿第 {i} 件：先問剩下容量 {rest} 的子問題
        take = vi + sub;               //@ @guide 拿 ＝ {vi} ＋ 子問題的 {sub} @tts [next] 拿的價值是 {vi} 加上子問題回傳的 {sub}
    }
    result = (skip > take) ? skip : take;  //@ @guide 比較：不拿 {skip}、拿 {take} @tts [next] 比大小：不拿 {skip}、拿 {take}
    memo[i][w] = result;               //@ @guide 把答案存進記憶表第 {i} 列第 {w} 行\n{memo[i][w]:orange}\n{memo} @tts [next] 把答案 {result} 記進表裡。下次再問到同一格，就不用再算一次
    return result;                     //@ @guide 回傳 {result} ← max(不拿 {skip}, 拿 {take}) @tts [next] 這一層的答案是 {result}，交回上一層
}                                      //@ @tts [next] 這一層結束，沿呼叫樹返回
int main() {
    int best = knap(3, 6);             //@ @guide 一樣從右下角問起：knap(3, 6)\n記憶表一開始全是 -1（還沒算過）：{memo} @tts [next] 一樣從右下角問起，記憶表現在全是負一，代表都還沒算過 | @2 [next] 算完了，回到 main @layout sidebar:50 open:callgraph,container
    std::cout << "最大價值：" << best << "\n";  //@ @guide 答案 {best}，和前兩課一樣\n記憶表：{memo}\n有值的格子就是第 ③ 課那張表的一部分 —— 遞迴只填了用得到的那幾格 @tts [next] 答案一樣是 {best}。看看這張記憶表：它就是填表那一課的同一張表，只是遞迴只填了用得到的幾格 @layout sidebar:58 open:container
    return 0;                          //@ @tts [continue] 兩種寫法算的是同一張表：填表法整張填滿，記憶化只填問到的格子。教案播放完畢
}
