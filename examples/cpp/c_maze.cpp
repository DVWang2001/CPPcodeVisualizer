// 教案：layout maze: —— 把二維容器換成迷宮配色
#include <iostream>
#include <vector>

int main() {
    // 0=可走 1=牆 2=已走過。刻意寫成一行：多行初始化清單的碼會被歸到收尾的 `};`，
    // 那一行會變成 main 的第一個停駐點，很容易漏掉註解而讓自動播放一開始就卡住。
    std::vector<std::vector<int>> grid = {{0, 1, 0, 0}, {0, 1, 0, 1}, {0, 0, 0, 1}}; //@ @guide 迷宮：{grid}\n0 是通道、1 是牆 @tts [next] 三列四行的迷宮，勾起來的是迷宮配色 @layout sidebar:50 open:container maze:grid
    int r = 0, c = 0;                      //@ @guide 迷宮：{grid}\n從左上角 (0,0) 出發 @tts [next] 從左上角出發
    for (int step = 0; step < 3; ++step) { //@ @guide 迷宮：{grid}\n目前位置 ({r},{c}) @tts [next] 準備往下走一格 | @2 [next] 繼續往下，走過的格子會換色
        grid[r][c] = 2;                    //@ @guide 標記走過：{grid[r][c]}\n整體：{grid} @tts [next] 把目前這一格標記成已走過
        if (r + 1 < 3) {                   //@ @guide 還能不能再往下？目前 r={r} @tts [next] 檢查下面還有沒有格子
            ++r;                           //@ @guide 往下移到 r={r} @tts [next] 往下移一格
        }
    }
    return 0;                              //@ @tts [continue] 走完三步，教案播放完畢
}
