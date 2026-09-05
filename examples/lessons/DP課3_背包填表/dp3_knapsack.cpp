// 教案：DP 課 ③——0/1 背包 Bottom-up（全班填表）
// 跟第 ② 課比，兩層迴圈和表的大小完全一樣，只有中間決定「這一格填什麼」的那幾行變了。
// 老師：把教案存進自己的帳號，開「即時課堂」讓學生掃 QR code；最後一題是全班重建整張表。
// 換班級時改 capacity 或 weights，整張表就換一組，正解由程式自己重算，不必手動改答案。
#include <algorithm>
#include <iostream>
#include <vector>

int main() {
    const int capacity = 6;                                                     //@ @guide 背包最多裝 6 單位重量 @tts [next] 今天這個背包，最多裝六單位的重量 @layout sidebar:58 open:container close:locals
    const std::vector<int> weights = {3, 2, 2};                                 //@ @guide 三件物品的重量：{weights} @tts [next] 有三件物品，重量分別是三、二、二
    const std::vector<int> values = {5, 3, 4};                                  //@ @guide 重量：{weights}\n價值：{values} @tts [next] 價值分別是五、三、四。每件物品只有一個，要嘛拿、要嘛不拿
    const int n = 3;                                                            //@ @guide 物品共 {n} 件 @tts [next] 物品共三件
    std::vector<std::vector<int>> dp(n + 1, std::vector<int>(capacity + 1, 0)); //@ @guide 四列七行，先全部填 0：{dp}\ndp[i][w]＝只用前 i 件物品、容量上限 w 時的最大價值\n第 0 列代表一件都還沒看，所以全是 0 @tts [next] 這張表和上一課一樣是四列七行。第 i 列代表只用前 i 件物品，第 w 行代表容量上限是 w。第零列一件都不能用，所以全是零
    for (int i = 1; i <= n; ++i) {                                              //@ @guide 外層迴圈選一列：現在把第 {i} 件物品加進來考慮\n{dp} @tts [next] 外層迴圈每跑一圈就多考慮一件物品 | @2 [next] 這一列填完了，再多考慮一件，現在是第 {i} 件 @layout sidebar:58 open:container
        int wi = weights[i - 1];                                                //@ @guide 第 {i} 件的重量\n{weights[i - 1]:orange} @tts [next] 先把這一件的重量拿出來 | @2 [next] 換這一件的重量
        int vi = values[i - 1];                                                 //@ @guide 第 {i} 件：重量 {wi}\n它的價值\n{values[i - 1]:orange} @tts [next] 再把它的價值拿出來，這一件重 {wi} | @2 [next] 這一件重 {wi}
        for (int w = 0; w <= capacity; ++w) {                                   //@ @guide 內層迴圈選一行：第 {i} 列，容量上限 {w}\n這一件重 {wi}、值 {vi}\n{dp[i][w]:lightblue} @tts [next] 內層迴圈把容量上限從零一路試到六 | @2 [next] 容量上限往右加一，現在是 {w}
            int skip = dp[i - 1][w];                                            //@ @guide 不拿第 {i} 件：答案就是上一列同一行\n{dp[i - 1][w]:pink} 抄到 {dp[i][w]:lightblue} @tts [next] 先看不拿這一件。不拿的話，能拿的價值就跟上一列同一行一樣 | @2 [next] 不拿的話，抄上面那一格
            int take = 0;                                                       //@ @guide 不拿的話是 {skip}\n先假設這一件放不下，拿的價值記 0 @tts [next] 不拿是 {skip}。接著看拿的話會是多少，先假設放不下 | @2 [next] 不拿是 {skip}
            if (wi <= w) {                                                      //@ @guide 這一件重 {wi}，現在容量上限是 {w}\n放得下才有得比 @tts [next] 放得下嗎？這一件重 {wi}，現在的容量上限是 {w} | @2 [next] 重 {wi}，容量 {w}
                int rest = w - wi;                                              //@ @guide 拿了它，容量從 {w} 剩下 {w} 減 {wi} @tts [next] 如果拿了它，容量就會剩下這麼多 | @2 [next] 拿了之後剩下的容量
                take = vi + dp[i - 1][rest];                                    //@ @guide 拿：{vi} ＋ 上一列容量 {rest} 那一格\n{dp[i - 1][rest]:orange} 加上這一件的價值 @tts [next] 拿的價值，是它自己的 {vi}，加上剩下容量 {rest} 在上一列的最佳解 | @2 [next] {vi} 加上上一列容量 {rest} 那一格
            }
            dp[i][w] = std::max(skip, take);                                    //@ @guide 不拿是 {skip}，拿是 {take}\n這一格填大的那個\n{dp[i][w]:lightblue} @tts [next] 不拿是 {skip}，拿是 {take}，兩個取大的填進這一格 | @2 [next] 不拿 {skip}、拿 {take}，取大的
        }
    }
    int best = dp[n][capacity];                                                 //@ @guide 整張表填完了：{dp}\n答案就在右下角\n{dp[3][6]:orange} @tts [next] 表填完了。請在手機上把整張表重建出來
    std::cout << "最大價值：" << best << "\n";                                    //@ @guide 右下角 dp[3][6] ＝ {best}\n拿第 1 件和第 3 件：重量 3 加 2 等於 5，價值 5 加 4 等於 9\n容量還剩 1 沒用到 —— 最佳解不一定要把背包塞滿 @tts [next] 容量六的最大價值是 {best}。注意它只用掉五單位重量，最佳解不一定要把背包塞滿
    return 0;                                                                   //@ @tts [continue] 兩層迴圈的形狀和上一課一樣，只有中間那幾行換了公式。教案播放完畢
}
