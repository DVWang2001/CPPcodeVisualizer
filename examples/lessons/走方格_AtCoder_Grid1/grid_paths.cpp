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
    std::cin >> h >> w;                          //@ @tts [continue] @layout sidebar:55 open:container close:locals
    std::vector<std::string> g(h);
    for (int i = 0; i < h; ++i) {
        std::cin >> g[i];
    }

    std::vector<std::vector<int>> dp(h + 1, std::vector<int>(w + 1, 0)); //@ @guide 建立表 dp，大小是 (h+1) 乘 (w+1)，多墊一列、一行，全填 0 @tts [next] 這一行先做一張表，不過我們故意讓它比地圖多一列、多一行。多出來的那一圈先全部填 0
    dp[0][1] = 1;                                //@ @guide 在墊片列放一個 1，起點就能用「上面加左邊」自動算出 1 @tts [next] 這裡動個小手腳：墊片列裡，緊貼在起點正上方的那一格塞 1。這樣等一下算到起點，用「上面加左邊」就會自動算出 1，不用再特別判斷這一格是不是起點
    for (int i = 1; i <= h; ++i) {               //@ @guide 外層迴圈：一列一列往下填表 @tts [next] 外層迴圈，一列一列往下填 | @2 [next] 這一列填完了，看還有沒有下一列 | @3 [next] 下一列 | @4 [next] 列都填完了 @layout sidebar:55 open:container
        for (int j = 1; j <= w; ++j) {           //@ @guide 內層迴圈：第 i 列由左往右走完 @tts [next] 現在填第 {i} 列，內層迴圈會由左往右，把這一列一格一格走完 | @2 [next] 第 {i} 列，看看右邊還有沒有 | @3 [next] 往右一格 | @6 [next] 第 {i} 列，一樣由左往右 | @7 [next] 下一格 | @11 [next] 第 {i} 列 | @12 [next] 右
            if (g[i - 1][j - 1] == '#') {        //@ @guide 判斷地圖上第 i 列第 j 行是不是牆 @tts [next] 第 {i} 列第 {j} 行。橘色是上面，綠色是左邊。先問一下，這一格是不是牆 | @2 [next] 第 {i} 列第 {j} 行，是牆嗎 | @4 [next] 第 {i} 列第 {j} 行，牆嗎 | @7 [next] 牆嗎 @layout pair:dp,g
                dp[i][j] = 0;                    //@ @guide 是牆：這一格的走法數填 0 @tts [next] 是牆，走不進來，所以走法有 0 種 | @2 [next] 又是牆，填 0
                continue;                        //@ @guide 這一格處理完，跳到下一格 @tts [next] 這一格處理完了，換下一格 | @2 [next] 換下一格
            }
            int up = dp[i - 1][j];               //@ @guide 不是牆：先讀上面那格的走法數 up @tts [next] 不是牆。能走到這一格的路，只有兩種來源。先看從[anim]上面來的 | @2 [next] 從[anim]上面來的 | @4 [next] [anim]上面 | @7 [next] [anim]上 @layout pop:dp:orange
            int left = dp[i][j - 1];             //@ @guide 再讀左邊那格的走法數 left @tts [next] 上面來的有 {up} 種。再看從[anim]左邊來的 | @2 [next] 上面 {up} 種，再看[anim]左邊 | @4 [next] 上面 {up}，[anim]左邊 | @7 [next] {up}，[anim]左 @layout pop:dp:lime
            dp[i][j] = (up + left) % MOD;        //@ @guide 這一格的走法數 = up 加 left（取餘數 MOD） @tts [next] 兩邊加起來，就是這一格的答案：上面 {up} 加左邊 {left}[anim] | @2 [next] 上面 {up} 加左邊 {left}[anim] | @4 [next] {up} 加 {left}[anim] | @7 [next] 加起來[anim] @layout pull:dp:orange,lime->lightblue
        }
    }
    std::cout << dp[h][w] << "\n";               //@ @guide 整張表填完，印出右下角的走法數 dp[h][w] @tts [next] 表填完了，答案就是右下角那一格 @layout open:live_quiz close:container
    return 0;                                    //@ @tts [continue] 每一格都是「上面加左邊」，牆填 0。教案播放完畢
}
