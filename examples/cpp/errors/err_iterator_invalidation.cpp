// 錯誤教案 #7：迭代器失效（push_back 後仍使用舊迭代器）
// BUG：vector 的容量用完時 push_back 會重新配置記憶體，舊的迭代器指向已釋放的舊區塊。
// 學生常見想法：「迭代器就是一個指向元素的指標，不會因為 push_back 而改變」。
// 修正：push_back 之後重新取得 begin()，或事先 reserve() 足夠容量（但仍須注意）。
#include <iostream>
#include <vector>

int main() {
    std::vector<int> v = {1, 2, 3};   // size == capacity == 3
    auto it = v.begin();              // 指向 v[0]
    v.push_back(4);                   // 容量不足，重新配置，舊區塊被釋放
    std::cout << "*it = " << *it << "（應為 1）" << std::endl;   // BUG：使用失效的迭代器
    return 0;
}
