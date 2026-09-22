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
    for (int i = 0; i < h; ++i) {                //@ @guide 一列一列把地圖讀進來 @tts [next] 接下來一列一列把地圖讀進來 | @2 [next] 讀完一列，看還有沒有下一列
        std::cin >> g[i];                        //@ @guide 讀第 {i} 列地圖\n. 是通道、# 是牆 @tts [next] 讀第 {i} 列。點是通道，井字號是牆 | @2 [next] 讀第 {i} 列
    }

    std::vector<std::vector<int>> dp(h + 1, std::vector<int>(w + 1, 0)); //@ @guide 表開 (h+1) x (w+1)，多墊一列、一行\ndp[r][c] 對應地圖上的 (r-1, c-1)；第 0 列、第 0 行整排先都是 0\n（表要等這一行執行完才長出來）@tts [next] 這一行做一張表，故意比地圖多一列、多一行，多出來的那一圈全部先填 0
    dp[0][1] = 1;                                //@ @guide 墊片列塞一個 1，讓起點能用「上面 ＋ 左邊」自動算出來\n{dp}\n起點 (0,0) 對應 dp[1][1]：它的上面是這一格，左邊是另一塊墊片（本來就是 0），加起來剛好是 1——不用再特別判斷起點 @tts [next] 這裡動個手腳：墊片列裡緊貼在起點正上方的那一格塞 1。等一下算到起點，會用「上面加左邊」自動算出 1，不用再特別判斷這一格是不是起點
    for (int i = 1; i <= h; ++i) {               //@ @guide 外層迴圈：一列一列往下填\n{dp} @tts [next] 外層迴圈一列一列往下填 | @2 [next] 這一列填完了，看還有沒有下一列 @layout sidebar:55 open:container
        for (int j = 1; j <= w; ++j) {           //@ @guide 現在填第 {i} 列（對應地圖第 {i} - 1 列）\n內層迴圈由左往右走完這一列\n{dp} @tts [next] 現在填第 {i} 列，內層迴圈由左往右走完這一列 | @2 [next] 第 {i} 列，看還有沒有下一格
            if (g[i - 1][j - 1] == '#') {        //@ @guide 第 {i} 列第 {j} 行\n{dp[i][j]:lightblue} {g[i - 1][j - 1]:lightblue} 這一格，地圖上對應的就是亮起來那一格\n{dp[i - 1][j]:orange} 上面\n{dp[i][j - 1]:lime} 左邊\n先看這一格是不是牆（地圖上的 # 就是牆） @tts [next] 第 {i} 列第 {j} 行。橘色是上面，綠色是左邊。先問這一格是不是牆 | @2 [next] 第 {i} 列第 {j} 行，是牆嗎 @layout pair:dp,g
                dp[i][j] = 0;                    //@ @guide 是牆，走不到，填 0\n{dp[i][j]:pink} {g[i - 1][j - 1]:pink} @tts [next] 是牆。走不進來，所以走法有 0 種 | @2 [next] 又是牆，填 0
                continue;                        //@ @guide 這一格處理完了 @tts [next] 換下一格 | @2 [next] 換下一格
            }
            int up = dp[i - 1][j];               //@ @guide 不是牆。能走到這一格的路有兩種來源，先讀上面那格\n{dp[i - 1][j]:orange} 上面\n{dp[i][j - 1]:lime} 左邊\n{dp[i][j]:lightblue} {g[i - 1][j - 1]:lightblue} 這一格 @tts [next] 能走到這一格的路只有兩種來源。先看從上面來的 | @2 [next] 從上面來的
            int left = dp[i][j - 1];             //@ @guide 上面來的有 {up} 種\n{dp[i - 1][j]:orange} 上面\n{dp[i][j - 1]:lime} 再讀左邊\n{dp[i][j]:lightblue} {g[i - 1][j - 1]:lightblue} 這一格 @tts [next] 上面來的有 {up} 種。再看從左邊來的 | @2 [next] 再看左邊
            dp[i][j] = (up + left) % MOD;        //@ @guide {dp[i - 1][j]:orange} 上面 {up}\n{dp[i][j - 1]:lime} 左邊 {left}\n{dp[i][j]:lightblue} {g[i - 1][j - 1]:lightblue} 寫進這一格\n{dp} @tts [next] 兩邊加起來就是這一格的答案：上面 {up} 加左邊 {left} | @2 [next] 上面 {up} 加左邊 {left}
        }
    }
    std::cout << dp[h][w] << "\n";               //@ @guide 整張表填完了：{dp}\n答案在右下角\n{dp[h][w]:orange} @tts [next] 表填完了。答案就是右下角那一格
    return 0;                                    //@ @tts [continue] 每一格都是「上面加左邊」，牆填 0。教案播放完畢
}
