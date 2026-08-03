// 教案：queue —— 一端進、另一端出
#include <iostream>
#include <queue>

int main() {
    std::queue<int> q;                     //@ @guide 空的佇列：{q} @tts [next] 先看一個空佇列 @layout sidebar:45 open:container
    for (int i = 1; i <= 4; ++i) {         //@ @guide 目前的佇列：{q} @tts [next] 從尾端放進 {i} | @2 [next] 繼續放，注意兩端箭頭的方向
        q.push(i);                         //@ @guide push 之後：{q} @tts [next] 放進尾端
    }
    while (!q.empty()) {                   //@ @guide front 是 {q}\n先進先出：先拿到最早放進去的 @tts [next] 從前端開始拿 | @2 [next] 拿到的順序和放進去的一樣
        q.pop();                           //@ @guide pop 之後：{q} @tts [next] 前端被拿掉
    }
    return 0;                              //@ @tts [continue] 佇列清空，教案播放完畢
}
