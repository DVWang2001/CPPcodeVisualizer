// 教案 #1：線性遞迴 — sum(4) = 4 + 3 + 2 + 1
// 約定：回傳值先存入 result 再 return，呼叫樹會顯示 ⇒ 值。
#include <iostream>

int sum(int n) {                       //@ @guide 進入 sum(n={n}) @tts 呼叫 sum，n 是 {n} @layout sidebar:45 open:callgraph
    if (n <= 1) {
        int result = 1;                //@ @guide [base case] n=1，答案是 1 @tts 到底了，這一層直接回傳 1
        return result;
    }
    int rest = sum(n - 1);             //@ @guide 先算 sum({n}-1)，這一層等它 @tts 這一層先暫停，往下呼叫 sum n 減 1
    int result = n + rest;             //@ @guide result = {n} + {rest} = {result} @tts 下層算完了，{n} 加 {rest} 得到 {result}
    return result;                     //@ @tts 把 {result} 交回給上一層
}

int main() {
    int total = sum(4);                //@ @guide 從 main 呼叫 sum(4) @layout sidebar:45 open:callgraph
    std::cout << total << std::endl;   //@ @guide 最終答案 {total}
    return 0;
}
