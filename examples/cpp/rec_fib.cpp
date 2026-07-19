// 教案 #3：樹狀遞迴 — fib(4)（全自動播放）
// 重點：一個問題分成兩個子問題；相同的子問題會被重複計算（注意 ×N 徽章）。
#include <iostream>

int fib(int n) {                       //@ @guide 進入 fib(n={n}) @tts [next] 呼叫 fib，這一層的 n 是 {n} @layout sidebar:45 open:callgraph
    int result;
    if (n <= 1) {                      //@ @tts [next] 判斷 {n} 是不是 0 或 1
        result = n;                    //@ @guide [base case] fib({n}) = {n} @tts [next] 到底了，fib {n} 就是 {n}
        return result;                 //@ @tts [next] 把 {result} 交回上一層
    }
    int a = fib(n - 1);                //@ @guide 左子問題 fib({n}-1) @tts [step-in] 處理左邊的子問題 fib {n} 減 1
    int b = fib(n - 2);                //@ @guide 右子問題 fib({n}-2)，左邊已得 {a} @tts [step-in] 左邊是 {a}，處理右邊的子問題 fib {n} 減 2
    result = a + b;                    //@ @guide result = {a} + {b} @tts [next] 左邊 {a} 加右邊 {b}
    return result;                     //@ @guide 得到 {result} @tts [next] 得到 {result}，交回上一層
}                                      //@ @tts [next] 這一層結束，沿呼叫樹往上歸
int main() {
    int total = fib(4);                //@ @guide 從 main 呼叫 fib(4) @tts [next] 從 main 出發，呼叫 fib(4) | @2 [next] 遞迴全部結束，回到 main @layout sidebar:45 open:callgraph
    std::cout << total << std::endl;   //@ @guide 最終答案 {total} @tts [next] 印出最終答案 {total}
    return 0;                          //@ @tts [continue] 教案播放完畢
}
