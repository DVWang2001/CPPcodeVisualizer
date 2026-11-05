// 錯誤教案 #3：懸空指標（delete 之後仍使用）
// BUG：delete p 之後，p 仍指向那塊記憶體，但它已經還給系統了；再寫入就是 use-after-free。
// 學生常見想法：「delete 之後指標還在，應該還能用」。
// 修正：delete 之後立刻 p = nullptr;，並避免再使用。
#include <iostream>

int main() {
    int* p = new int(5);
    std::cout << "*p = " << *p << std::endl;   // 正確：5
    delete p;                                  // 記憶體已釋放，p 變成懸空指標
    *p = 7;                                    // BUG：寫入已釋放的記憶體
    std::cout << "after free, *p = " << *p << std::endl;   // 結果不可預期
    return 0;
}
