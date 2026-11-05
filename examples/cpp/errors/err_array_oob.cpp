// 錯誤教案 #2：陣列越界（寫到相鄰的欄位）
// BUG：data 只有 4 格（索引 0~3），迴圈卻寫到 i <= 4，data[4] 實際落在 guard 上，guard 被蓋掉。
// 學生常見想法：「for (i = 0; i <= n) 才會跑完 n+1 次」。
// 修正：把條件改成 i < 4，或改用 std::array 並用 .size() 當邊界。
// 註：struct 內的成員記憶體連續排列，data[4] 必定與 guard 重疊（同一編譯器下可重現）。
#include <iostream>

struct Block {
    int data[4];
    int guard;     // 本來應該永遠是 42
};

int main() {
    Block b;
    b.guard = 42;
    for (int i = 0; i <= 4; i++) {   // BUG：應為 i < 4
        b.data[i] = i * 10;          // i == 4 時寫進 guard
    }
    std::cout << "guard = " << b.guard << "（應為 42）" << std::endl;
    return 0;
}
