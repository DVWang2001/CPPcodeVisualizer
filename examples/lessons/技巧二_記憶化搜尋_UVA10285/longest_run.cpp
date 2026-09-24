// 教案：技巧二 —— 記憶化搜尋（UVA 10285 Longest Run on a Snowboard）
// https://onlinejudge.org/external/102/10285.pdf
//
// 原題（走方格）：只能往右或往下走，所以 (i,j) 由小到大填表，剛好就是計算順序。
// 這一課在原題上改了兩個條件：
//   ① 可以往上下左右四個方向走，但只能走到「數值更大」的格子（所以路線不會繞回原地，沒有環）。
//   ② 只求一件事：最長的路徑，最多能走幾格。
// 走法不再固定往右下，(i,j) 由小到大填表就填不出來，所以改用記憶化搜尋：
// 用到才算，算過就記住。
//
// 【課堂用法】程式先示範遞迴怎麼一層一層往下問、遇到死路怎麼回頭，然後快轉到全部算完，
// 把 dp 表藏起來，出一題課堂題目：全班一起算出 dp 表。答對之後才打開表對答案。
//   dp[i][j] ＝ 從 (i,j) 出發，每一步走到上下左右「數值更大」的格子，最多能走幾格（含自己）
//   0 表示「還沒算過」
#include <iostream>
#include <vector>

int h, w;
std::vector<std::vector<int>> a, dp;
int di[4] = {-1, 1, 0, 0};
int dj[4] = {0, 0, -1, 1};

int solve(int i, int j) {
    int result;
    if (dp[i][j] != 0) {                         //@ @guide 先查記憶表：從 ({i},{j}) 出發的答案算過了嗎？\n{dp[i][j]:lightblue}\n0 代表還沒算過 @tts [next] 動手算之前，先查記憶表：從第 {i} 列第 {j} 欄出發的答案算過了嗎 | @2 [next] 先查記憶表：第 {i} 列第 {j} 欄 | @3 [continue] 後面每一格的做法都一模一樣，我們直接快轉，等每個起點都問完 | @4 [continue] 繼續 @layout sidebar:55 open:container,callgraph close:locals
        result = dp[i][j];                       //@ @guide [查表命中#green] 算過了，直接拿現成的答案\n{dp[i][j]:lime} @tts [next] 命中！這一格算過了，直接拿現成的答案，不用再往下走一次
        return result;                           //@ @guide 回傳 {result} ← 直接查記憶表 @tts [next] 把查到的答案 {result} 交回上一層
    }
    int best = 1;                                //@ @guide 沒算過，要自己算\n至少能走 1 格：站在這一格本身 @tts [next] 沒算過，只好自己算。最少能走一格，就是站在這一格 | @2 [next] 沒算過，先設最少一格
    for (int d = 0; d < 4; ++d) {                //@ @guide 依序看上、下、左、右四個方向 @tts [next] 依序看上、下、左、右四個方向 | @2 [next] 看下一個方向
        int ni = i + di[d], nj = j + dj[d];      //@ @guide 這個方向的鄰格是第 {d} 個方向\n現在在 ({i},{j}) @tts [next] 算出這個方向鄰格的座標 | @2 [next] 算出鄰格座標
        if (ni < 0 || ni >= h || nj < 0 || nj >= w) continue;   //@ @guide 走出地圖外了嗎？\n{a[i][j]:lightblue} 現在這格 @tts [next] 這個方向走出地圖外了嗎？出界就跳過 | @2 [next] 出界嗎
        if (a[ni][nj] <= a[i][j]) continue;      //@ @guide 鄰格 {a[ni][nj]} 比現在這格 {a[i][j]} 大嗎？\n{a[i][j]:lightblue} 現在\n{a[ni][nj]:orange} 鄰格\n只能走到更大的格子 @tts [next] 鄰格是 {a[ni][nj]}，現在這格是 {a[i][j]}。只能走到更大的格子，不比較大就跳過 | @2 [next] 鄰格 {a[ni][nj]}，現在 {a[i][j]}，比較大嗎
        int sub = solve(ni, nj);                 //@ @guide 問鄰格 ({ni},{nj}) 從它出發最多能走幾格\n{a[ni][nj]:orange} @tts [step-in] 問問看，從這個更大的鄰格出發，最多能走幾格
        if (1 + sub > best) best = 1 + sub;      //@ @guide 走過去的話：1 ＋ 鄰格的 {sub} ＝ {sub} 再加 1\n目前最好 {best}\n{dp} @tts [next] 走過去的話，就是一格加上鄰格的答案 {sub}。比目前最好的大就更新
    }
    dp[i][j] = best;                             //@ @guide 四個方向都看完了\n把答案 {best} 寫進記憶表\n{dp[i][j]:orange}\n{dp} @tts [next] 四個方向都看完了，把答案 {best} 記進表裡，下次再問到這一格就不用再算
    result = best;                               //@ @guide 這一層的答案是 {best} @tts [next] 這一層的答案是 {best}
    return result;                               //@ @guide 回傳 {result} ← 四個方向中最長的一條 @tts [next] 把答案 {best} 交回上一層
}                                                //@ @tts [next] 這一層結束，沿呼叫樹返回
int main() {
    std::cin >> h >> w;                          //@ @tts [continue] @layout sidebar:55 open:container close:locals
    a.assign(h, std::vector<int>(w));
    for (int i = 0; i < h; ++i) {
        for (int j = 0; j < w; ++j) {
            std::cin >> a[i][j];
        }
    }
    dp.assign(h, std::vector<int>(w, 0));        //@ @guide {a}\n再準備一張一樣大的 dp 表，全填 0，代表都還沒算過\n{dp} @tts [next] 再準備一張一樣大的記憶表，全部填零，代表每一格都還沒算過 @layout pair:a,dp
    int ans = 0;                                 //@ @guide 答案是「所有起點裡最長的一條」\n先設 0 @tts [next] 起點可以是任何一格，所以答案是所有起點裡最長的一條。先設零
    for (int i = 0; i < h; ++i) {                //@ @guide 每一格都當一次起點 @tts [next] 每一格都當一次起點，一列一列來 | @2 [next] 換下一列
        for (int j = 0; j < w; ++j) {            //@ @guide 起點 ({i},{j}) @tts [next] 由左往右，每一格當起點 | @2 [next] 換下一格
            int cur = solve(i, j);               //@ @guide 問：從 ({i},{j}) 出發，最多能走幾格？\n{dp} @tts [step-in] 問問看：從這一格出發，最多能走幾格 | @2 [next] 這個起點問完了
            if (cur > ans) ans = cur;            //@ @guide 這個起點的答案 {cur}，目前最長 {ans} @tts [next] 這個起點的答案是 {cur}，和目前最長的比一比 | @2 [next] 比一比
        }
    }
    std::cout << ans << "\n";                    //@ @guide [課堂題目#red] 每個起點都問完了，先把 dp 表藏起來\n換你們算：dp 表 @tts [next] 每個起點都問完了，可是我先把 dp 表藏起來。請大家用手機自己算出來 @layout open:live_quiz close:container,callgraph
    return 0;                                    //@ @guide 揭曉：dp 表\n{dp}\n答案 {ans} 就是表裡最大的那一格\n有值的格子都是從那一格出發的最長路徑 @tts [continue] 走法不再固定往右下，就沒有現成的填表順序，所以改成用到才算、算過就記住。教案播放完畢 @layout sidebar:58 open:container,callgraph close:live_quiz
}

// 隨機測資腳本（🎲 按鈕用；放檔尾才不會擠動上面的行號）
// @random h = 3
// @random w = 3
// @random print h w
// @random matrix h w 1..9 distinct
