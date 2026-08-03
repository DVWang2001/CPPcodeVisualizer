// 教案：stack —— 開口向右的容器，只看得到頂端
#include <iostream>
#include <stack>

int main() {
    std::stack<int> s;                     //@ @guide 空的堆疊：{s} @tts [next] 先看一個空堆疊 @layout sidebar:45 open:container
    for (int i = 1; i <= 4; ++i) {         //@ @guide 目前的堆疊：{s} @tts [next] 把 {i} 推進堆疊 | @2 [next] 繼續推，新元素永遠疊在開口那一端
        s.push(i);                         //@ @guide push 之後：{s} @tts [next] 推進去了
    }
    while (!s.empty()) {                   //@ @guide 頂端是 {s}\n後進先出：先拿到最後推進去的 @tts [next] 開始一個一個拿出來 | @2 [next] 拿到的順序和推進去的相反
        s.pop();                           //@ @guide pop 之後：{s} @tts [next] 頂端被拿掉
    }
    return 0;                              //@ @tts [continue] 堆疊清空，教案播放完畢
}
