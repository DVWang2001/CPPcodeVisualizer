// 教案：std::array —— 長度編譯期固定，沒有容量虛線框
#include <array>
#include <iostream>

int main() {
    std::array<int, 5> a = {5, 3, 9, 1, 7}; //@ @guide 這一行一次給定五格的內容\n（陣列要等這一行執行完才長出來，下一步就看得到）@tts [next] 五格一次給定，長度之後改不了 @layout sidebar:45 open:container
    for (int i = 0; i < 5; ++i) {          //@ @guide {a}\n目前看第 {i} 格：{a[i]} @tts [next] 走訪第 {i} 格 | @2 [next] 高亮跟著索引往右移
        std::cout << a[i] << " ";          //@ @guide 印出 {a[i]} @tts [next] 印出這一格的值
    }
    a[0] = 100;                            //@ @guide 改掉第 0 格之後：{a}\n長度不變，只有值變了 @tts [continue] array 的長度改不了，只能改值，教案播放完畢
    return 0;
}
