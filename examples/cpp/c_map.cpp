// 教案：map —— key 自動排序的 key-value 表格
#include <iostream>
#include <map>
#include <string>

int main() {
    std::map<std::string, int> m;          //@ @guide 空的 map：{m} @tts [next] 先看一張空表 @layout sidebar:45 open:container
    m["bob"] = 90;                         //@ @guide 目前的 map：{m} @tts [next] 放進第一組 key-value
    m["alice"] = 85;                       //@ @guide 加入 alice 之後：{m}\nalice 排到 bob 前面，map 依 key 排序 @tts [next] 新的 key 自動插到正確位置，不是接在後面
    m["carol"] = 78;                       //@ @guide 加入 carol：{m} @tts [next] 再放一組
    m["alice"] = 95;                       //@ @guide 重複 key 只會覆蓋：{m}\n筆數沒有增加 @tts [continue] key 重複時是覆蓋不是新增，教案播放完畢
    return 0;
}
