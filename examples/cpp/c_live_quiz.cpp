// 教案：QR 即時課堂 —— 播放到綁定的行會自動出題，學生掃 QR 用手機作答
// 老師端：工具列「即時課堂」→ 畫面出現 QR → 按 Run 開始播放
// 學生端：手機相機掃 QR → 輸入暱稱 → 題目自動跳出來 → 作答
#include <iostream>
#include <vector>

int main() {
    std::vector<int> v = {3, 1, 4, 1, 5};  //@ @guide 這一行放進等一下要處理的五個數字 @tts [next] 這是等一下要處理的五個數字 @layout sidebar:45 open:container
    int sum = 0;                           //@ @guide 資料：{v}\n這一行把累加器 sum 歸零 @tts [next] 累加器歸零。第一題就綁在這一行
    for (int i = 0; i < 5; ++i) {          //@ @guide 累加到第 {i} 個，目前 sum = {sum} @tts [next] 開始累加 | @2 [next] 一個一個加進去
        sum = sum + v[i];                  //@ @guide 加之前 sum = {sum}\n這一行把第 {i} 格加進去 @tts [next] 加上 {v} 的第 {i} 格
    }
    int mx = v[0];                         //@ @guide 累加結束，sum = {sum}\n接下來找最大值，先假設是第一個 @tts [next] 累加跑完了。第二題綁在這一行
    for (int j = 1; j < 5; ++j) {          //@ @guide 找最大值，目前 mx = {mx} @tts [next] 換一輪，這次找最大的 | @2 [next] 比較下一個
        if (v[j] > mx) {                   //@ @guide 比較 v[{j}] 和目前的 mx = {mx} @tts [next] 這一個比較大嗎 | @2 [next] 再比一次
            mx = v[j];                     //@ @guide 舊的 mx = {mx}\n這一行把它換成 v[{j}] @tts [next] 比較大，換它當最大值 | @2 [next] 又找到更大的
        }
    }
    std::cout << sum << " " << mx << "\n";  //@ @guide 總和 {sum}，最大值 {mx} @tts [next] 印出兩個答案。第三題綁在這一行
    return 0;                              //@ @tts [continue] 教案播放完畢
}
