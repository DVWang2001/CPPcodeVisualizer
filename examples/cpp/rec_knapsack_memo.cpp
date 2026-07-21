// 教案 #5：三維狀態 DP — 0/1 背包 記憶化版（對照 rec_knapsack）（全自動播放）
// 和 naive 版並排看：naive 把 knap(2,2,2) 整棵子樹算「兩次」；這裡第二次直接查表返回、
// 收成一個葉節點（×2 徽章仍在，但不再展開），重複子樹被剪掉 —— 這就是 DP。
#include <iostream>
#include <cstring>

int wt[]  = {2, 2, 1};
int vol[] = {1, 1, 2};
int val[] = {3, 2, 2};
const int N = 3;
int memo[N + 1][5][4];   // memo[i][w][v]，-1 = 還沒算過

int knap(int i, int w, int v) {        //@ @layout sidebar:45 open:callgraph
    int result;
    if (i == N) {                      //@ @guide 子問題 knap({i},{w},{v}) @tts [next] 子問題 knap 第 {i} 件、剩重量 {w} 體積 {v}；物品看完了嗎（i={i}）
        result = 0;                    //@ @guide [base case] 沒物品，價值 0 @tts [next] 到底了，價值是 0
        return result;                 //@ @tts [next] 把 0 交回上一層
    }
    if (memo[i][w][v] >= 0) {          //@ @tts [next] 先查記憶表：knap({i},{w},{v}) 這個狀態算過了嗎？
        result = memo[i][w][v];        //@ @guide [記憶化命中] 這個狀態算過了，直接查表 @tts [next] 命中！直接拿現成答案，不再往下展開整棵子樹
        return result;                 //@ @tts [next] 把查到的答案 {result} 交回上一層
    }
    int skip = knap(i + 1, w, v);      //@ @guide 分支一：不拿第 {i} 件 @tts [step-in] 處理「不拿第 {i} 件」這條分支
    int take = 0;                      //@ @tts [next] 先假設拿不了，take 記 0
    if (w >= wt[i] && v >= vol[i])     //@ @tts [next] 第 {i} 件拿得下嗎？它需要重量 {wt[i]} 體積 {vol[i]}
        take = val[i] + knap(i + 1, w - wt[i], v - vol[i]);  //@ @guide 分支二：拿第 {i} 件 @tts [step-in] 拿得下，處理「拿第 {i} 件」這條分支
    result = (skip > take) ? skip : take;  //@ @guide 比較：不拿得 {skip}、拿得 {take} @tts [next] 兩條分支比大小：不拿是 {skip}、拿是 {take}
    memo[i][w][v] = result;            //@ @guide 存入記憶表 knap({i},{w},{v})={result} @tts [next] 把答案 {result} 記進記憶表，下次同狀態就不用再算
    return result;                     //@ @guide 這一層最大價值 {result} @tts [next] 這一層答案是 {result}，交回上一層
}                                      //@ @tts [next] 這一層結束，沿呼叫樹返回
int main() {
    memset(memo, -1, sizeof(memo));    //@ @tts [next] 先把記憶表全設成「未算」（-1） @layout sidebar:45 open:callgraph
    int best = knap(0, 4, 3);          //@ @guide 從 main 呼叫 knap(0,4,3) @tts [next] 從 main 出發：背包容量 重量4 體積3 | @2 [next] 全部算完，回到 main
    std::cout << best << std::endl;    //@ @guide 最大價值 {best} @tts [next] 印出最大價值 {best}
    return 0;                          //@ @tts [continue] 教案播放完畢
}
