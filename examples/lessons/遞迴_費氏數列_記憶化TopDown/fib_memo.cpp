// 教案：費氏數列 top-down（遞迴 + 記憶化）——fib(6) 只會呼叫 11 次
// 沒有記憶時 fib(6) 要呼叫 25 次；有 memo 之後每個 n 只真正展開一次，其餘直接查表。
// 公式：呼叫次數 = 2n - 1（n = 6 → 11 次）。看呼叫樹：左邊一路往下算，右邊全是查表葉節點。
#include <iostream>
#include <vector>

std::vector<int> memo(7, -1);   // memo[n] ＝ fib(n)，-1 ＝ 還沒算過

int fib(int n) {
    int result;
    if (n <= 1) {                      //@ @guide 子問題 fib({n}) @tts [next] 子問題是 fib {n}，先看是不是 0 或 1 | @2 [next] fib {n}，是 0 或 1 嗎 @layout sidebar:50 open:callgraph,container
        result = n;                    //@ @guide [邊界#gray] fib({n}) = {n} @tts [next] 到底了，fib {n} 就是 {n}
        return result;                 //@ @guide 回傳 {result} ← 邊界 @tts [next] 把 {result} 交回上一層
    }
    if (memo[n] >= 0) {                //@ @guide 先查記憶表：fib({n}) 算過了嗎？\n{memo[n]:lightblue} @tts [next] 動手算之前，先查記憶表第 {n} 格 | @2 [next] 先查表第 {n} 格
        result = memo[n];              //@ @guide [查表命中#green] 算過了，直接抄\n{memo[n]:lime} @tts [next] 命中！fib {n} 算過了，直接拿現成的答案，整棵子樹不用再展開 | @2 [next] 命中，直接抄
        return result;                 //@ @guide 回傳 {result} ← 查表 @tts [next] 把查到的 {result} 交回上一層
    }
    int a = fib(n - 1);                //@ @guide 沒算過，要自己算。左子問題 fib({n}-1) @tts [step-in] 沒算過，只好自己算。先處理左邊的子問題 fib {n} 減 1 | @2 [step-in] 左邊 fib {n} 減 1 | @4 [step-in] 左邊
    int b = fib(n - 2);                //@ @guide 右子問題 fib({n}-2)，左邊已得 {a} @tts [step-in] 左邊是 {a}，再處理右邊的子問題 fib {n} 減 2 | @2 [step-in] 左邊 {a}，右邊 fib {n} 減 2 | @4 [step-in] 右邊
    result = a + b;                    //@ @guide result = {a} + {b} @tts [next] 左邊 {a} 加右邊 {b} | @2 [next] {a} 加 {b} | @4 [next] 相加
    memo[n] = result;                  //@ @guide 把答案存進記憶表第 {n} 格\n{memo[n]:orange} @tts [next] 把答案 {result} 記進表裡。下次再問到 fib {n}，就不用再算一次 | @2 [next] 把 {result} 記進表裡 | @4 [next] 記進表裡
    return result;                     //@ @guide 回傳 {result} ← {a} + {b}\n已存入記憶表：{memo[n]:orange} @tts [next] 這一層的答案是 {result}，交回上一層 | @2 [next] 答案 {result}，往上交
}                                      //@ @tts [next] 這一層結束，沿呼叫樹返回
int main() {
    int total = fib(6);                //@ @guide 從 main 呼叫 fib(6)\n記憶表一開始全是 -1（還沒算過） @tts [next] 從 main 出發問 fib 六，記憶表現在全是負一，代表都還沒算過 | @2 [next] 全部算完了，回到 main @layout sidebar:50 open:callgraph,container
    std::cout << total << std::endl;   //@ @guide 答案 {total}\n每個 n 只真正算過一次，所以全部只呼叫 11 次（沒有記憶要 25 次） @tts [next] 答案是 {total}。每個 n 只真正算過一次，全部呼叫了十一次，沒有記憶的話要二十五次 @layout sidebar:58 open:callgraph,container
    return 0;                          //@ @tts [continue] 這就是 top-down：從大問題問起，遇到算過的就直接查表。教案播放完畢
}
