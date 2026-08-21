// 教案：Dijkstra 最短路徑（逐輪填表）
// 圖是無向加權圖，六個節點。學生要填的是「每一輪確定一個節點之後，各點的暫定距離」——
// 也就是課本上那張 Dijkstra 表。考的是過程，不是只有最後答案。
#include <iostream>
#include <vector>

int main() {
    const int N = 6;
    const int INF = 99;  // 刻意用 99 而不是 INT_MAX：表格裡要看得懂

    // 無向圖的鄰接矩陣。0 表示沒有邊。
    //        0   1   2   3   4   5
    std::vector<std::vector<int>> w = {
        {  0,  7,  9,  0,  0, 14},
        {  7,  0, 10, 15,  0,  0},
        {  9, 10,  0, 11,  0,  2},
        {  0, 15, 11,  0,  6,  0},
        {  0,  0,  0,  6,  0,  9},
        { 14,  0,  2,  0,  9,  0},
    };

    std::vector<int> dist(N, INF);
    std::vector<bool> done(N, false);
    dist[0] = 0;

    // 每確定一個節點就存一列，最後就是「輪數 × 節點」的 Dijkstra 表
    std::vector<std::vector<int>> table;

    for (int step = 0; step < N; ++step) {
        int u = -1; //@ @guide 第 {step} 輪：要從還沒確定的點裡挑距離最小的 @tts [next] 每一輪先挑出目前最近的點
        for (int v = 0; v < N; ++v) {
            if (!done[v] && (u == -1 || dist[v] < dist[u])) u = v;
        }
        done[u] = true; //@ @guide 這一輪確定的是節點 {u}，它的最短距離就是 {dist[u]}，之後不會再變 @tts [next] 這個點的距離從現在起定案

        for (int v = 0; v < N; ++v) { //@ @guide 用剛確定的 {u} 去鬆弛它的鄰居 @tts [next] 看看繞過這個點會不會更近
            if (w[u][v] != 0 && !done[v] && dist[u] + w[u][v] < dist[v]) {
                dist[v] = dist[u] + w[u][v]; //@ @guide 找到更短的路：到 {v} 改成 {dist[v]} @tts [next] 更新這一格
            }
        }
        table.push_back(dist); //@ @guide 第 {step} 輪結束，把這一列存進表：{dist} @tts [next] 記下這一輪的結果 | @2 [next] 繼續下一輪
    }

    std::cout << "0 到各點的最短距離：";
    for (int v = 0; v < N; ++v) std::cout << dist[v] << " ";
    std::cout << "\n"; //@ @guide 六輪都結束了，完整的 Dijkstra 表是 {table} @tts [next] 請在手機填出整張表 @layout sidebar:52 open:container
    return 0;
}
