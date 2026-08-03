// 教案：string —— 每個字元一格
#include <iostream>
#include <string>

int main() {
    std::string s = "ABC";                 //@ @guide 初始字串：{s} @tts [next] 三個字元、三格 @layout sidebar:45 open:container font:1.3
    for (char ch = 'D'; ch <= 'F'; ++ch) { //@ @guide 目前的字串：{s} @tts [next] 準備把字元接到尾巴 | @2 [next] 繼續接，格子一格一格變多
        s.push_back(ch);                   //@ @guide 接上之後：{s} @tts [next] 多了一格
    }
    int idx = 1;                           //@ @guide 完整字串：{s} @tts [next] 六格都接好了，挑一格來高亮
    std::cout << s[idx] << "\n";           //@ @guide 高亮第 {idx} 格：{s[idx]} @tts [next] 字串也能用索引高亮
    s.pop_back();                          //@ @guide pop_back 之後：{s} @tts [continue] 少掉最後一格，教案播放完畢
    return 0;
}
