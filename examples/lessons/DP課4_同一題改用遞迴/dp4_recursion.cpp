// 教案：DP 課 ④——同一題，改用遞迴（給已經會填表的人看）
// knap(i, w)「只用前 i 件物品、容量上限 w 時的最大價值」＝ 第 ③ 課的 dp[i][w]，同一個東西。
// 差別只在誰先算：填表是從左上一路填到右下；遞迴是從右下角問下去，需要哪一格才算哪一格。
// 重點畫面：呼叫樹上 knap(1, 4) 出現兩次（×2 徽章）——同一個子問題被整棵展開了兩遍。
#include <iostream>

int weights[] = {3, 2, 2};   // 和第 ③ 課同一組物品
int values[] = {5, 3, 4};

int knap(int i, int w) {               //@ @layout sidebar:45 open:callgraph
    int result;
    if (i == 0) {                      //@ @guide 進入子問題 knap(i, w)：前 i 件、容量上限 w @tts [next] 這個子問題是 knap 前 {i} 件、容量 {w}；先看物品是不是一件都不能用了 | @2 [next] knap 前 {i} 件、容量 {w}
        result = 0;                    //@ @guide i 為 0（一件都不能用）時，答案直接是 0 @tts [next] 一件都不能用，價值是零。這就是表上第零列那一排零
        return result;                 //@ @guide 把 0 交回上一層 @tts [next] 把零交回上一層
    }
    int wi = weights[i - 1];           //@ @guide 取出第 i 件的重量，存進 wi @tts [next] 先拿出第 {i} 件的重量 | @2 [next] 第 {i} 件的重量
    int vi = values[i - 1];            //@ @guide 取出第 i 件的價值，存進 vi @tts [next] 這一件重 {wi}，再拿出它的價值 | @2 [next] 這一件重 {wi}
    int skip = knap(i - 1, w);         //@ @guide 分支一：不拿第 i 件，去問前 i 減 1 件、容量不變的子問題，結果存進 skip @tts [step-in] 處理不拿第 {i} 件：容量沒變，但少一件可以選
    int take = 0;                      //@ @guide 先把拿的價值 take 設為 0，假設放不下 @tts [next] 不拿是 {skip}。再看拿的話會是多少，先假設放不下 | @2 [next] 不拿是 {skip}
    if (wi <= w) {                     //@ @guide 判斷放不放得下：wi 不超過容量 w 才有得比較 @tts [next] 放得下嗎？重 {wi}，容量 {w} | @2 [next] 重 {wi}，容量 {w}
        int rest = w - wi;             //@ @guide 算出拿了之後剩下的容量 rest = w 減 wi @tts [next] 拿了之後容量會剩下這麼多 | @2 [next] 拿了之後剩下的容量
        int sub = knap(i - 1, rest);   //@ @guide 分支二：拿第 i 件，去問剩餘容量 rest 的子問題，結果存進 sub @tts [step-in] 處理拿第 {i} 件：先問剩下容量 {rest} 的子問題
        take = vi + sub;               //@ @guide 拿的價值 take = vi 加上 sub @tts [next] 拿的價值是它自己的 {vi}，加上子問題回傳的 {sub}
    }
    result = (skip > take) ? skip : take;  //@ @guide 取不拿與拿兩者較大的值，作為這一層的答案 result @tts [next] 兩條分支比大小：不拿 {skip}、拿 {take}
    return result;                     //@ @guide 把 result 交回上一層；它就是填表時 dp[i][w] 那一格 @tts [next] 這一層的答案是 {result}，交回上一層。它就是填表那一課裡的同一格
}                                      //@ @tts [next] 這一層結束，沿呼叫樹返回
int main() {
    int best = knap(3, 6);             //@ @guide 從 main 問右下角 knap(3, 6)，答案存進 best @tts [next] 從 main 出發，直接問右下角那一格：前三件、容量六 | @2 [next] 整棵樹算完了，回到 main @layout sidebar:45 open:callgraph
    std::cout << "最大價值：" << best << "\n";  //@ @guide 印出最大價值 best，和填表的答案相同；但遞迴樹上有子問題被算了兩次 @tts [next] 答案一樣是 {best}。但是看這棵樹，有一個子問題被算了兩次
    return 0;                          //@ @tts [continue] 同一個子問題算兩次，就是白做工。下一課把算過的記起來。教案播放完畢
}
