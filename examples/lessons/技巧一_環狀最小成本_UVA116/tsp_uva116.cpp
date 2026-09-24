// 教案：技巧一 —— 環狀相鄰 ＋ 最小成本路徑（UVA 116 Unidirectional TSP）
// https://onlinejudge.org/external/1/116.pdf
//
// 原題（走方格）：只能往右或往下走，數有幾種走法。
// 這一課在原題上加了兩個條件：
//   ① 一欄一欄往右走，每一步可以去「右上、正右、右下」；第一列的上面是最後一列（上下環狀相連）。
//   ② 每一格有成本。起點是最左欄任何一列、終點是最右欄任何一列，求總成本最小的路；
//      成本同分時，選「列號序列」字典序最小的那一條。
//
// 【課堂用法】程式先示範最右欄與倒數第二欄的前兩格怎麼算，然後把兩張表藏起來，
// 出兩題課堂題目：全班一起算出 dp 表、再算出 nxt 表。答對之後才把表打開對答案，
// 最後用 nxt 表把最佳路線走出來。
//   dp[i][j]  ＝ 從 (i,j) 一路走到最右欄的最小總成本
//   nxt[i][j] ＝ 從 (i,j) 出發，最佳路線的下一步要走到「右邊那一欄的第幾列」
#include <algorithm>
#include <iostream>
#include <vector>

const int INF = 1000000000;

int main() {
    int h, w;
    std::cin >> h >> w;                          //@ @tts [continue] @layout sidebar:55 open:container close:locals
    std::vector<std::vector<int>> cost(h, std::vector<int>(w));
    for (int i = 0; i < h; ++i) {
        for (int j = 0; j < w; ++j) {
            std::cin >> cost[i][j];
        }
    }

    std::vector<std::vector<int>> dp(h, std::vector<int>(w, 0));   //@ @guide {cost}\n再開一張一樣大的 dp 表\ndp[i][j] ＝ 從 (i,j) 一路走到最右欄的最小總成本\n（表要等這一行執行完才長出來） @tts [next] 再開一張一樣大的表，叫 dp。dp 的第 i 列第 j 欄，代表從這一格一路走到最右欄，最少要花多少成本 @layout pair:cost,dp
    std::vector<std::vector<int>> nxt(h, std::vector<int>(w, -1)); //@ @guide {dp}\n再開一張 nxt 表，先全填 -1\nnxt[i][j] ＝ 從 (i,j) 出發，最佳路線的下一步要走到右邊那一欄的第幾列\n（表要等這一行執行完才長出來） @tts [next] 再開一張 nxt 表，先填負一，表示還沒決定。它記的是：從這一格出發，最好的下一步要走到右邊那一欄的第幾列，等一下要靠它把路線走出來
    for (int i = 0; i < h; ++i) {                //@ @guide 先處理最右欄：它是終點欄\n{dp}\n{nxt} @tts [next] 先處理最右欄，它是終點欄 | @2 [next] 看還有沒有下一列
        dp[i][w - 1] = cost[i][w - 1];           //@ @guide 最右欄沒有下一步，走到這裡就結束\n{cost[i][w - 1]:orange} 這一格自己的成本\n{dp[i][w - 1]:lightblue} 就是 dp @tts [next] 最右欄沒有下一步，走到這裡就結束，所以 dp 就等於這一格自己的成本 | @2 [next] 第 {i} 列也一樣 | @3 [fast @5] 最右欄其他格子都一樣，直接跳到這一欄填完 | @5 [next] 最右欄全部填好了
    }
    for (int j = w - 2; j >= 0; --j) {           //@ @guide 從倒數第二欄開始，一欄一欄往左算\n{dp}\n{nxt} @tts [next] 接下來從倒數第二欄開始，一欄一欄往左算。為什麼往左？因為每一格的答案，要用到它右邊那一欄的答案 | @2 [fast @4] 每一欄的算法都一樣，直接跳到全部算完 | @4 [next] 每一欄都算完了 @layout pair:cost,dp
        for (int i = 0; i < h; ++i) {            //@ @guide 現在算第 {j} 欄，一列一列算 @tts [next] 現在算第 {j} 欄，一列一列算 | @2 [next] 換下一列 | @3 [fast @6] 這一欄其他格子做法一樣，直接跳到這一欄算完 | @6 [next] 這一欄算完了
            int cand[3] = {(i - 1 + h) % h, i, (i + 1) % h}; //@ @guide 第 {j} 欄第 {i} 列\n{cost[i][j]:lightblue} 這一格\n往右走有三個候選：右上（第 i-1 列）、正右（第 i 列）、右下（第 i+1 列）\n第一列的上面是最後一列，所以列號要取餘數 % h @tts [next] 這一格往右走有三個候選：右上、正右、右下。第一列的上面是最後一列，所以要取餘數 | @2 [next] 第 {i} 列的三個候選列
            std::sort(cand, cand + 3);           //@ @guide 三個候選由小排到大\n成本同分時，列號小的先比、先佔位\n這就是「字典序最小」 @tts [next] 先把三個候選列由小排到大。成本同分的時候，列號小的先被選中，這就是字典序最小 | @2 [next] 排好序
            int best = INF;                      //@ @guide 先假設最小成本是無限大 @tts [next] 先假設最小成本是無限大，等一下一個一個比 | @2 [next] 最小成本先設無限大
            for (int k = 0; k < 3; ++k) {        //@ @guide 依序看三個候選 @tts [next] 依序看三個候選 | @2 [next] 看下一個候選
                int r = cand[k];                 //@ @guide 取出第 {k} 個候選 @tts [next] 取出第 {k} 個候選列 | @2 [next] 取出下一個候選列
                if (dp[r][j + 1] < best) {       //@ @guide 候選第 {r} 列：右邊那欄的成本\n{dp[r][j + 1]:orange}\n目前最好 {best}\n比較小才換，同分不換 @tts [next] 候選第 {r} 列，它的成本比目前最好的還小嗎？小才換，同分不換，所以列號小的會先佔位 | @2 [next] 比一比
                    best = dp[r][j + 1];         //@ @guide 更小，記下這個成本\n{dp[r][j + 1]:orange} @tts [next] 更小，記下這個成本 | @2 [next] 更小，換成這個
                    nxt[i][j] = r;               //@ @guide 同時記下：從這一格出發，下一步走到第 {r} 列\n{nxt[i][j]:pink} @tts [next] 同時記下，下一步走到第 {r} 列 | @2 [next] 下一步換成第 {r} 列
                }
            }
            dp[i][j] = cost[i][j] + best;        //@ @guide 這一格的 dp ＝ 自己的成本 ＋ 右邊最好的路\n{cost[i][j]:lightblue} ＋ {best}\n{dp[i][j]:lightblue}\n{nxt} @tts [next] 這一格的 dp，等於自己的成本，加上右邊最好的那條路，寫進表裡 | @2 [next] 同樣算出這一格的 dp @layout pair:dp,nxt
        }
    }
    int start = 0;                               //@ @guide [課堂題目#red] 兩張表都算完了，先把它們藏起來\n換你們算：dp 表、nxt 表 @tts [next] 兩張表都算完了，可是我先把它們藏起來。請大家用手機自己算出 dp 表 @layout open:live_quiz close:container
    for (int i = 1; i < h; ++i) {                //@ @guide 起點可以是最左欄的任何一列\n挑 dp 最小的，同分挑列號小的 @tts [next] 起點可以是最左欄的任何一列，逐列比較，挑成本最小的，同分挑列號小的 | @2 [fast @5] 其他列也是一樣的比法，直接跳到比完 | @5 [next] 比完了
        if (dp[i][0] < dp[start][0]) {           //@ @guide 第 {i} 列比目前的起點更小嗎？\n同分不換 @tts [next] 第 {i} 列比目前的起點成本更小嗎 | @2 [next] 再比一次
            start = i;                           //@ @guide 更小，起點換成第 {i} 列 @tts [next] 更小，起點換成第 {i} 列 | @2 [next] 換成第 {i} 列
        }
    }
    int r = start;                               //@ @guide [課堂題目#red] 接著請算出 nxt 表 @tts [next] 接著請大家算出 nxt 表。最右欄沒有下一步，填負一 @layout open:live_quiz close:container
    for (int j = 0; j < w; ++j) {                //@ @guide 揭曉：兩張表都打開\n{dp}\n{nxt}\n從起點開始，每一欄查 nxt 表，就能把路線走出來 @tts [next] 兩張表現在打開了，大家對一下答案。有了 nxt 表，就能從起點一欄一欄把最佳路線走出來 | @2 [next] 下一欄 @layout sidebar:60 open:container close:live_quiz pair:dp,nxt
        std::cout << r + 1 << (j + 1 < w ? " " : "\n");  //@ @guide 第 {j} 欄走第 {r} 列（輸出從 1 算起，所以印 r + 1）\n{nxt[r][j]:orange} @tts [next] 第 {j} 欄走第 {r} 列，輸出從一開始算，所以印的是 r 加一 | @2 [next] 第 {j} 欄走第 {r} 列
        r = nxt[r][j];                           //@ @guide 查 nxt 表，下一欄要走哪一列\n{nxt[r][j]:orange} @tts [next] 查 nxt 表，看下一欄要走第幾列 | @2 [next] 再查 nxt 表
    }
    std::cout << dp[start][0] << "\n";           //@ @guide 最小總成本 ＝ 起點那一格的 dp\n{dp[start][0]:orange} @tts [next] 最小總成本，就是起點那一格的 dp
    return 0;                                    //@ @tts [continue] 原題只問走法數，這一課多了兩個條件：環狀相鄰，讓列號要取餘數；最小成本，讓每一格要比較三個候選，並用 nxt 表記下最好的下一步。教案播放完畢
}

// 隨機測資腳本（🎲 按鈕用；放檔尾才不會擠動上面的行號）
// @random h = 5
// @random w = 4
// @random print h w
// @random matrix h w 1..9
