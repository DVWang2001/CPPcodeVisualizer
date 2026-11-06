// 教案：DP 課 ①——格子有編號
// 這一課只教兩件事：每一格有自己的編號（索引），迴圈可以一格一格走過去。
// 後面幾課的畫面都是這一課長出來的，程式的形狀不會再變。
#include <iostream>
#include <vector>

int main() {
    std::vector<int> row(7, 0);      //@ @guide 這一行做出一列 7 格，每格先填 0 @tts [next] 我們做一列七個格子，每一格現在都是零 @layout sidebar:55 open:container close:locals
    for (int w = 0; w <= 6; ++w) {   //@ @guide 迴圈讓 w 從 0 走到 6，每一圈處理一格\n{row} @tts [next] w 是格子的編號，從零開始數 | @2 [next] w 往右移一格，看還有沒有下一格 @layout sidebar:55 open:container
        int value = w * 10;          //@ @guide 這一行算出第 w 格要填的值：w 乘 10\n{row[w]:lightblue} @tts [next] 現在是第 {w} 格。這一格要填什麼，是由它的編號算出來的 | @2 [next] 由編號 {w} 算出這一格的值
        row[w] = value;              //@ @guide 把算好的值寫進第 w 格（row[w] = value）\n{row[w]:lightblue} @tts [next] 把 {value} 寫進第 {w} 格 | @2 [next] 寫進第 {w} 格，值是 {value}
    }
    int third = row[3];              //@ @guide 整列填完後，這一行把第 3 格的值讀進 third\n{row}\n{row[3]} @tts [next] 表填滿了。接下來讀第三格看看
    std::cout << third << "\n";      //@ @guide 印出 third，也就是第 3 格的值 @tts [next] 第三格是 {third}。讀跟寫用的是同一個寫法，中括號裡放編號
    return 0;                        //@ @tts [continue] 這一課就這樣：格子有編號，迴圈一格一格走。教案播放完畢
}
