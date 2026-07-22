// 教案：UML 物件圖 P1 — 顯示一個自訂 class 物件的欄位即時值
// 在行尾寫 //@ @guide uml:p，右側「UML 物件圖」面板就把物件 p 畫成 UML 框。
#include <iostream>
#include <string>

class Point {
public:
    int x;
    int y;
    std::string label;
};

int main() {
    Point p;                //@ @tts [next] 宣告一個 Point 物件 p
    p.x = 3;                //@ @guide uml:p @tts [next] 設定 p.x = 3，看 UML 圖裡 x 變成 3
    p.y = 7;                //@ @guide uml:p @tts [next] 設定 p.y = 7
    p.label = "origin";     //@ @guide uml:p @tts [next] 設定 p.label
    std::cout << p.x + p.y << std::endl;  //@ @guide uml:p @tts [continue] 教案播放完畢
    return 0;
}
