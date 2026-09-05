// 教案：DP 課 ②——兩層迴圈把一張表填滿
// 跟第 ① 課比只多一件事：格子從一列變成一張表，所以編號要兩個（列 i、行 w）。
// 這張表的大小（4 列 7 行）和第 ③ 課的背包表一模一樣，中間的公式故意寫得很笨。
#include <iostream>
#include <vector>

int main() {
    std::vector<std::vector<int>> table(4, std::vector<int>(7, 0));  //@ @guide 這一行要做一張四列七行的表，每一格先填 0\n第 0 列是邊界，等一下不會去動它\n（表要等這一行執行完才長出來）@tts [next] 這次是一張四列七行的表，先全部填零。第零列留著不動 @layout sidebar:58 open:container close:locals
    for (int i = 1; i <= 3; ++i) {          //@ @guide 外層迴圈選一列：現在要填第 {i} 列\n{table} @tts [next] 外層迴圈負責選列，從第一列開始 | @2 [next] 這一列填完了，換第 {i} 列 @layout sidebar:58 open:container
        for (int w = 0; w <= 6; ++w) {      //@ @guide 內層迴圈選一行：第 {i} 列，第 {w} 行\n{table[i][w]:lightblue} @tts [next] 內層迴圈負責從左到右走完這一列 | @2 [next] 往右一格，現在是第 {w} 行
            int value = i * 10 + w;         //@ @guide 這一格要填的值，只由 {i} 和 {w} 決定 @tts [next] 這一格填的是 i 乘以十再加 w | @2 [next] 由 {i} 和 {w} 算出這一格的值
            table[i][w] = value;            //@ @guide 把 {value} 寫進第 {i} 列第 {w} 行\n{table[i][w]:lightblue} @tts [next] 把 {value} 寫進這一格 | @2 [next] 寫進第 {i} 列第 {w} 行
        }
    }
    int corner = table[3][6];               //@ @guide 整張表填滿了：{table}\n右下角那一格：{table[3][6]:orange} @tts [next] 兩層迴圈走完，整張表就滿了
    std::cout << corner << "\n";            //@ @guide 右下角 table[3][6] = {corner} @tts [next] 右下角是 {corner}
    return 0;                               //@ @tts [continue] 記住這個形狀：兩層迴圈，中間那幾行決定每一格填什麼。下一課只換掉中間那幾行。教案播放完畢
}
