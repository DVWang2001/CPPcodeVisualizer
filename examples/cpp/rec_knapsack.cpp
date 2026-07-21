// 教案 #4：三維狀態 DP — 0/1 背包（雙限制：重量 + 體積）（全自動播放）
// 狀態 (i, w, v) 三維。不同拿法會抵達相同的 knap(2,2,2) → ×2 重複子問題，
// 這就是「連 3 維狀態也會重疊、所以需要記憶化（DP）」的畫面。
#include <iostream>

int wt[]  = {2, 2, 1};   // 各物品重量
int vol[] = {1, 1, 2};   // 各物品體積
int val[] = {3, 2, 2};   // 各物品價值
const int N = 3;

int knap(int i, int w, int v) {        //@ @guide 進入 knap(i={i}, w={w}, v={v}) @tts [next] 呼叫 knap，從第 {i} 件看起，還剩重量 {w} 體積 {v} @layout sidebar:45 open:callgraph
    int result;
    if (i == N) {                      //@ @guide 子問題 knap({i},{w},{v}) @tts [next] 這個子問題是 knap 第 {i} 件、剩重量 {w} 體積 {v}；先看物品是否都看完了（i={i}）
        result = 0;                    //@ @guide [base case] 沒物品可拿，價值 0 @tts [next] 到底了，沒東西可拿，這一層價值是 0
        return result;                 //@ @tts [next] 把 0 交回上一層
    }
    int skip = knap(i + 1, w, v);      //@ @guide 分支一：不拿第 {i} 件 @tts [step-in] 處理「不拿第 {i} 件」這條分支
    int take = 0;                      //@ @tts [next] 先假設拿不了，take 記 0
    if (w >= wt[i] && v >= vol[i])     //@ @tts [next] 第 {i} 件拿得下嗎？它需要重量 {wt[i]} 體積 {vol[i]}
        take = val[i] + knap(i + 1, w - wt[i], v - vol[i]);  //@ @guide 分支二：拿第 {i} 件 @tts [step-in] 拿得下，處理「拿第 {i} 件」這條分支
    result = (skip > take) ? skip : take;  //@ @guide 比較：不拿得 {skip}、拿得 {take} @tts [next] 兩條分支比大小：不拿是 {skip}、拿是 {take}
    return result;                     //@ @guide 這一層最大價值 {result} @tts [next] 這一層答案是 {result}，交回上一層
}                                      //@ @tts [next] 這一層結束，沿呼叫樹返回
int main() {
    int best = knap(0, 4, 3);          //@ @guide 從 main 呼叫 knap(0,4,3) @tts [next] 從 main 出發：背包容量 重量4 體積3，共三件物品 | @2 [next] 全部算完，回到 main @layout sidebar:45 open:callgraph
    std::cout << best << std::endl;    //@ @guide 最大價值 {best} @tts [next] 印出最大價值 {best}
    return 0;                          //@ @tts [continue] 教案播放完畢
}
