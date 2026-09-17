// 教案：走方格路徑計數 —— AtCoder Educational DP Contest H (Grid 1)
// https://atcoder.jp/contests/dp/tasks/dp_h
//
// 這份程式可以直接提交上判題。program_input 放的是官方 Sample 1，答案是 3。
//
// 【課堂用法】把 dp[i][j] = (up + left) % MOD; 那一行刪掉，讓全班一起補。
// 其他每一行（讀輸入、邊界、取模、輸出）都寫好了，沒寫過程式的學生也接得上——
// 他們要產出的就是前一節課用手在表格上填了幾十遍的那個動作。
#include <iostream>
#include <string>
#include <vector>

const int MOD = 1000000007;

int main() {
    int h, w;
    std::cin >> h >> w;                          //@ @guide 先讀地圖的大小：h 列、w 行 @tts [next] 先讀進地圖有幾列幾行 @layout sidebar:55 open:container close:locals
    std::vector<std::string> g(h);               //@ @guide 準備 {h} 個字串，一列地圖存一個\n（要等這一行執行完才建好）@tts [next] 準備好放地圖的空間
    for (int i = 0; i < h; ++i) std::cin >> g[i]; //@ @guide 讀第 {i} 列地圖\n. 是通道、# 是牆 @tts [next] 一列一列把地圖讀進來。點是通道，井字號是牆 | @2 [next] 讀第 {i} 列

    std::vector<std::vector<int>> dp(h, std::vector<int>(w, 0)); //@ @guide 這一行要做一張和地圖一樣大的表，每格先填 0\ndp[i][j] ＝ 走到第 i 列第 j 行有幾種走法\n（表要等這一行執行完才長出來）@tts [next] 接著做一張和地圖一樣大的表。每一格記的是「走到這一格有幾種走法」
    dp[0][0] = 1;                                //@ @guide 起點只有一種走法：待在原地\n{dp} @tts [next] 起點填 1。站在起點本身就是一種走法，這是整張表的種子
    for (int i = 0; i < h; ++i) {                //@ @guide 外層迴圈選一列：現在填第 {i} 列\n{dp} @tts [next] 外層迴圈一列一列往下 | @2 [next] 這一列填完了，換第 {i} 列 @layout sidebar:55 open:container
        for (int j = 0; j < w; ++j) {            //@ @guide 內層迴圈選一行：第 {i} 列第 {j} 行\n{dp[i][j]:lightblue} @tts [next] 內層迴圈由左往右走完這一列 | @2 [next] 往右一格，現在是第 {j} 行
            if (i == 0 && j == 0) continue;      //@ @guide 起點已經填過 1 了，跳過不要蓋掉 @tts [next] 起點剛才填過了，跳過 | @2 [next] 不是起點，繼續
            if (g[i][j] == '#') {                //@ @guide 先看這一格是不是牆（地圖上的 # 就是牆） @tts [next] 先問這一格是不是牆 | @2 [next] 是牆嗎
                dp[i][j] = 0;                    //@ @guide 是牆，走不到，填 0\n{dp[i][j]:pink} @tts [next] 是牆。走不進來，所以走法有 0 種 | @2 [next] 又是牆，填 0
                continue;                        //@ @guide 這一格處理完了 @tts [next] 換下一格 | @2 [next] 換下一格
            }
            int up = (i > 0) ? dp[i - 1][j] : 0; //@ @guide 從上面來的走法有幾種\n{dp[i - 1][j]:orange}（在第 0 列就沒有上面，算 0）@tts [next] 能走到這一格的路只有兩種來源。先看從上面來的 | @2 [next] 從上面來的
            int left = (j > 0) ? dp[i][j - 1] : 0; //@ @guide 上面來的有 {up} 種\n再看從左邊來的\n{dp[i][j - 1]:lime} @tts [next] 上面來的有 {up} 種。再看從左邊來的 | @2 [next] 再看左邊
            dp[i][j] = (up + left) % MOD;        //@ @guide {dp[(i > 0) ? i - 1 : 99999][j]:orange} 上面 {up}\n{dp[i][(j > 0) ? j - 1 : 99999]:lime} 左邊 {left}\n{dp[i][j]:lightblue} 寫進這一格\n{dp} @tts [next] 兩邊加起來就是這一格的答案：上面 {up} 加左邊 {left} | @2 [next] 上面 {up} 加左邊 {left}
        }
    }
    std::cout << dp[h - 1][w - 1] << "\n";       //@ @guide 整張表填完了：{dp}\n答案在右下角\n{dp[h - 1][w - 1]:orange} @tts [next] 表填完了。答案就是右下角那一格
    return 0;                                    //@ @tts [continue] 每一格都是「上面加左邊」，牆填 0。教案播放完畢
}
