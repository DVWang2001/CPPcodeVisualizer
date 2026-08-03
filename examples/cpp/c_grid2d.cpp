// 教案：vector<vector<int>> —— 自動切換成二維格狀視圖
#include <iostream>
#include <vector>

int main() {
    std::vector<std::vector<int>> g(3, std::vector<int>(4, 0)); //@ @guide 三列四行，全是 0：{g} @tts [next] 二維容器自動變成格狀視圖 @layout sidebar:50 open:container
    for (int i = 0; i < 3; ++i) {          //@ @guide 格狀視圖：{g} @tts [next] 開始填第 {i} 列 | @2 [next] 一列一列往下填
        for (int j = 0; j < 4; ++j) {      //@ @guide 第 {i} 列，第 {j} 行 @tts [next] 移到第 {j} 行 | @2 [next] 沿著這一列往右移
            g[i][j] = i * 4 + j;           //@ @guide 正在寫入 {g[i][j]}\n整體：{g} @tts [next] 寫入第 {i} 列第 {j} 行 | @2 [next] 高亮跟著兩個索引一起走
        }
    }
    return 0;                              //@ @tts [continue] 十二格都填完了，教案播放完畢
}
