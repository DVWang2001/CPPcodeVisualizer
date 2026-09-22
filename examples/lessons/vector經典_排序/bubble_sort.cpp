// 教案：泡沫排序（Bubble Sort）—— 相鄰兩個比一比，比錯順序就交換
//
// 核心動作只有一個：從左走到右，每次看相鄰兩格，前面比後面大就交換。
// 走完一輪，最大的數字一定會被「推」到最右邊；走 n 輪整個陣列就排好了。
// 陣列故意用 3 個數字，走一輪半就能看完一次交換、一次不交換、排序完成。
#include <iostream>
#include <vector>
#include <algorithm>
using namespace std;

void bubbleSort(vector<int>& arr) {
    int n = arr.size();                          //@ @guide {arr} @tts [next] 準備排序這個陣列
    for (int i = 0; i < n; i++) {                 //@ @guide 外層迴圈：走第幾輪\n總共 {n} 個數字\n{arr} @tts [next] 總共 {n} 個數字，開始第一輪 | @2 [next] 這一輪走完了，看還有沒有下一輪
        for (int j = 0; j < n - i - 1; j++) {     //@ @guide 第 {i} 輪，內層迴圈比對相鄰兩格\n{arr} @tts [next] 由左往右比對相鄰的兩格 | @2 [next] 往右移一格，繼續比
            if (arr[j] > arr[j + 1]) {            //@ @guide {arr[j]:orange} 跟 {arr[j + 1]:lime} 比一比，前面比後面大嗎 @tts [next] 比一比這兩格，前面比後面大嗎 | @2 [next] 再比這兩格
                swap(arr[j], arr[j + 1]);         //@ @guide 前面比較大，交換！\n{arr[j]:orange} {arr[j + 1]:lime} @tts [next] 前面比較大，交換這兩格 | @2 [next] 交換
            }
        }
    }
}

int main() {
    vector<int> arr = {3, 1, 2};                 //@ @tts [next] 準備一個還沒排序的陣列，3、1、2
    bubbleSort(arr);                              //@ @guide 排序前：{arr} @tts [step-in] 開始排序
    cout << "排序後：";                            //@ @guide 排序後：{arr} @tts [next] 排序完成，看最後結果
    for (int x : arr) cout << x << " ";           //@ @tts [next] 印出排好的陣列
    cout << endl;                                 //@ @tts [continue] 相鄰比一比、錯了就交換，走完全部輪次就排好了。教案播放完畢
    return 0;
}
