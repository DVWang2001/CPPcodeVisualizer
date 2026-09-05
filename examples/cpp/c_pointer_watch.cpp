// 教案：memory_watch 面板 —— 追指標指向哪裡
#include <iostream>

int main() {
    int a = 10;                            //@ @guide 這一行把 10 存進 a @tts [next] 先準備兩個變數 @layout sidebar:50 open:memory_watch close:locals
    int b = 20;                            //@ @guide a 已經有了：{a}\n這一行再把 20 存進 b @tts [next] 第二個變數也準備好了
    int* p = &a;                           //@ @guide p 指向 a，a 的值是 {a} @tts [next] 看右側記憶體面板，箭頭從 p 指到 a
    *p = 11;                               //@ @guide 透過 p 改值之後 a = {a}\n沒有直接碰 a，卻改掉了它 @tts [next] 透過指標改值，a 跟著變
    p = &b;                                //@ @guide p 改指向 b，b = {b} @tts [next] 指標本身改指向，箭頭換一個目標
    *p = 21;                               //@ @guide b = {b}，a 仍然是 {a} @tts [continue] 這次改到的是 b，a 沒有被動到，教案播放完畢
    return 0;
}
