// 教案：TTS 控制 —— [speed:N] 放 @guide 欄、[wait:N] 當後綴、[step-out] 步出
#include <iostream>

int inner(int n) {                         //@ @guide [speed:0.8] 進入 inner(n={n}) @tts [next] 這一段開始放慢到零點八倍速唸 @layout sidebar:40 open:callgraph
    int result = n * 2;                    //@ @guide 這一行把 {n} 乘以 2 存進 result @tts [next] 先算出結果 [wait:1] 這裡靜默一秒，答案下一行就看得到
    return result;                         //@ @guide 回傳 {result} ← {n} × 2 @tts [step-out] 唸完自動步出，回到 main
}                                          //@ @tts [next] inner 結束，回到呼叫它的地方

int main() {
    int x = inner(21);                     //@ @guide [speed:1.0] 呼叫 inner(21)，答案回來之後才存進 x @tts [step-in] 步入 inner 看看 | @2 [next] 回來了，速度也調回一倍速
    std::cout << x << "\n";                //@ @guide 最終答案 {x} @tts [next] 這個詞測自訂發音：重[ㄔㄨㄥˊ]來一次
    return 0;                              //@ @tts [continue] 教案播放完畢
}
