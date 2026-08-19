// 教案：0/1 背包 Bottom-up DP
// 老師：先把教案存到 rosa 帳號，開啟「即時課堂」並讓學生掃 QR code。
// 學生：依序回答兩題觀念題，最後在手機重建完整 DP 表。
#include <algorithm>
#include <iostream>
#include <vector>

int main() {
    const int capacity = 7;
    const std::vector<int> weights = {1, 3, 4, 5};
    const std::vector<int> values = {1, 4, 5, 7};
    const int n = static_cast<int>(weights.size());
    std::vector<std::vector<int>> dp(n + 1, std::vector<int>(capacity + 1, 0)); //@ @guide dp 有 {dp}，第 0 列代表還沒看任何物品，所以全是 0 @tts [next] 建立五列八欄的表，第零列先填零 @layout sidebar:52 open:container
    for (int i = 1; i <= n; ++i) { //@ @guide 現在處理第 {i} 件物品；dp[i][w] 只使用前 i 件物品 @tts [next] 第一題：先確認狀態定義 | @2 [next] 換下一件物品
        for (int w = 0; w <= capacity; ++w) { //@ @guide 第 {i} 列目前計算容量 {w} @tts [next] 容量從零一路填到七 | @2 [next] 繼續往右填
            dp[i][w] = dp[i - 1][w]; //@ @guide 先選擇不拿第 {i} 件：dp[{i}][{w}] 沿用上一列 @tts [next] 第二題：放不下時答案就是上一列同一格 | @2 [next] 先複製不拿的答案
            if (weights[i - 1] <= w) { //@ @guide 第 {i} 件重量是 {weights[i - 1]}，目前容量是 {w} @tts [next] 放得下才比較拿與不拿 | @2 [next] 再檢查一次
                dp[i][w] = std::max(dp[i][w], values[i - 1] + dp[i - 1][w - weights[i - 1]]); //@ @guide 比較後 dp[{i}][{w}] = {dp[i][w]}，整張表是 {dp} @tts [next] 拿這件的價值加上剩餘容量的最佳解，再和不拿比較 | @2 [next] 這一格完成
            }
        }
    }
    int best = dp[n][capacity]; //@ @guide 四件物品都處理完了，完整 DP 表是 {dp} @tts [next] 最後一題：請在手機填出整張表
    std::cout << "最大價值：" << best << "\n"; //@ @guide dp[4][7] = {best}，可拿重量 3 與 4 的物品，價值 4 + 5 = 9 @tts [next] 容量七的最大價值是九
    return 0; //@ @tts [continue] Bottom-up 背包教案播放完畢
}
