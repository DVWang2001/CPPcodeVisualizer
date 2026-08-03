// 教案：vector —— 橫向格子陣列、容量虛線框、以 {v[i]} 高亮單一格
#include <iostream>
#include <vector>

int main() {
    std::vector<int> v;                    //@ @guide 空的 vector：{v} @tts [next] 先看一個空的 vector，等一下一格一格長出來 @layout sidebar:45 open:container font:1.2
    for (int i = 1; i <= 5; ++i) {         //@ @guide 目前的 vector：{v} @tts [next] 準備放進第 {i} 個元素 | @2 [next] 繼續 push_back，注意容量虛線框什麼時候才變大
        v.push_back(i * 10);               //@ @guide push_back 之後：{v} @tts [next] 放進去了，格子多一個
    }
    int idx = 2;                           //@ @guide 完整的 vector：{v} @tts [next] 五格都放好了，接下來挑一格來高亮
    std::cout << v[idx] << "\n";           //@ @guide 高亮索引 {idx}：{v[idx]} @tts [next] 高亮第 {idx} 格，其他格子維持原色
    v.pop_back();                          //@ @guide pop_back 之後：{v}\n注意 size 變小但容量沒有跟著變 @tts [continue] 拿掉最後一格，教案播放完畢
    return 0;
}
