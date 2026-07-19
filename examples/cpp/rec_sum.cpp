// 教案 #1：線性遞迴 — sum(4) = 4 + 3 + 2 + 1（全自動播放：Run 之後不需任何手動操作）
// 約定：result 在函式最外層宣告一次、各分支只賦值，return 前值已定，呼叫樹顯示 ⇒ 值。
#include <iostream>

int sum(int n) {                       //@ @guide 進入 sum(n={n}) @tts [next] 呼叫 sum，這一層的 n 是 {n} @layout sidebar:45 open:callgraph
    int result;
    if (n <= 1) {                      //@ @tts [next] 判斷這一層的 n，也就是 {n}，是不是已經到底
        result = 1;                    //@ @guide [base case] n={n}，答案是 1 @tts [next] 到底了，這一層的答案直接是 1
        return result;                 //@ @tts [next] 把 1 交回給上一層，注意看呼叫樹出現的綠色數字
    }
    int rest = sum(n - 1);             //@ @guide 先算 sum({n}-1)，這一層等它 @tts [step-in] 這一層先暫停，往下呼叫 sum {n} 減 1 | @4 [next] 下一層的答案回來了，繼續往下走
    result = n + rest;                 //@ @guide result = {n} + {rest} = {result} @tts [next] 下層算出 {rest}，加上自己的 {n} 得到 {result}
    return result;                     //@ @tts [next] 把 {result} 交回給上一層
}                                      //@ @tts [next] 這一層結束，沿著呼叫樹往上歸
int main() {
    int total = sum(4);                //@ @guide 從 main 呼叫 sum(4) @tts [next] 遞迴全部結束，回到 main @layout sidebar:45 open:callgraph
    std::cout << total << std::endl;   //@ @guide 最終答案 {total} @tts [next] 印出最終答案 {total}
    return 0;                          //@ @tts [continue] 教案播放完畢
}
