// 錯誤教案 #5：空指標解參考（走訪鏈結串列時超過最後一個節點）
// BUG：迴圈內同時讀 cur->next->val，但最後一個節點的 next 是 nullptr，
//      解參考 nullptr 在原生 Linux 會 SIGSEGV 崩潰。
// 註：本專案的 wasm 引擎不會崩潰，而是讀到位址 0x00000000 的值（0）。這是環境差異，
//     右側欄要說明，不改寫程式來追求崩潰。
// 學生常見想法：「while (cur) 跑完就結束，印 next 的值沒問題」。
// 修正：只在 cur->next != nullptr 時才讀 cur->next->val。
#include <iostream>

struct Node {
    int val;
    Node* next;
};

int main() {
    Node b{20, nullptr};
    Node a{10, &b};
    Node* cur = &a;
    while (cur != nullptr) {
        // BUG：最後一輪 cur->next 是 nullptr，cur->next->val 解參考空指標
        std::cout << "值：" << cur->val << "，下一個值：" << cur->next->val << std::endl;
        cur = cur->next;
    }
    return 0;
}
