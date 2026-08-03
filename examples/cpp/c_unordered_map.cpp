// 教案：unordered_map —— 一樣是 key-value，但沒有排序保證
#include <iostream>
#include <string>
#include <unordered_map>

int main() {
    std::unordered_map<std::string, int> u; //@ @guide 空的雜湊表：{u} @tts [next] 先看一張空的雜湊表 @layout sidebar:45 open:container
    u["bob"] = 90;                         //@ @guide 目前的雜湊表：{u} @tts [next] 放進第一組
    u["alice"] = 85;                       //@ @guide 加入 alice：{u}\n和 map 不同，這裡的順序不保證是字典序 @tts [next] 注意它擺放的位置，和 map 那篇比一比
    u["carol"] = 78;                       //@ @guide 加入 carol：{u} @tts [continue] 再放一組，教案播放完畢
    return 0;
}
