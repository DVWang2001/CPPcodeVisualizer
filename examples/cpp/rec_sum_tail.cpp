// 教案 #2：尾遞迴 — 和教案 #1 對照：答案在「遞」的路上就算好，
// 「歸」的路上同一個值直通到頂（每層 ⇒ 10）。
#include <iostream>

int sumTail(int n, int acc) {          //@ @guide 進入 sumTail(n={n}, acc={acc}) @tts 呼叫 sumTail，累加器已經是 {acc} @layout sidebar:45 open:callgraph
    if (n == 0) {
        int result = acc;              //@ @guide [base case] 答案就是 acc={acc} @tts 到底了，答案早就算好，是 {acc}
        return result;
    }
    int result = sumTail(n - 1, acc + n); //@ @guide 把 {n} 先加進 acc 再往下 @tts 先把 {n} 加進累加器，答案會原封不動傳回來
    return result;                     //@ @tts 下層的答案 {result} 直接轉交，不再計算
}

int main() {
    int total = sumTail(4, 0);         //@ @guide 對照教案 #1：這次答案在下坡路上算 @layout sidebar:45 open:callgraph
    std::cout << total << std::endl;   //@ @guide 最終答案 {total}
    return 0;
}
