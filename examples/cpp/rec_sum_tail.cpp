// 教案 #2：尾遞迴 — 和教案 #1 對照：答案在「遞」的路上就算好（全自動播放）
// 「歸」的路上同一個值直通到頂（每層 ⇒ 10）。result 在函式最外層宣告一次。
#include <iostream>

int sumTail(int n, int acc) {          //@ @guide 進入 sumTail(n={n}, acc={acc}) @tts [next] 呼叫 sumTail，n 是 {n}，累加器已經是 {acc} @layout sidebar:45 open:callgraph
    int result;
    if (n == 0) {                      //@ @tts [next] 判斷 n 是不是 0，目前 n 是 {n}
        result = acc;                  //@ @guide [base case] 答案就是 acc={acc} @tts [next] 到底了，答案早就在下坡路上算好，是 {acc}
        return result;                 //@ @tts [next] 把 {result} 交回上一層，接下來每一層都只是轉交
    }
    result = sumTail(n - 1, acc + n);  //@ @guide 把 {n} 先加進 acc 再往下 @tts [step-in] 先把 {n} 加進累加器再往下呼叫 | @5 [next] 下層答案原封不動回來了
    return result;                     //@ @tts [next] 這一層不做任何計算，直接轉交 {result}
}                                      //@ @tts [next] 沿呼叫樹往上，每一層都是同一個綠色數字
int main() {
    int total = sumTail(4, 0);         //@ @guide 對照教案 #1：這次答案在下坡路上算 @tts [next] 回到 main @layout sidebar:45 open:callgraph
    std::cout << total << std::endl;   //@ @guide 最終答案 {total} @tts [next] 印出最終答案 {total}
    return 0;                          //@ @tts [continue] 教案播放完畢
}
