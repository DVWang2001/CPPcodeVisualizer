// 錯誤教案 #1：整數溢位
// BUG：int 只能表示到 2147483647（INT_MAX），13! = 6227020800 超出範圍，溢位後數字變成怪值。
// 學生常見想法：「階乘就是一直乘，結果一定是正的」。
// 修正：改用 long long（或 unsigned long long，但 unsigned 不會變負，仍會繞回）。
#include <iostream>

int factorial(int n) {
    int result = 1;
    for (int i = 2; i <= n; i++) {
        result = result * i;   // 溢位發生在這一行
    }
    return result;
}

int main() {
    std::cout << "10! = " << factorial(10) << std::endl;   // 正確：3628800
    std::cout << "13! = " << factorial(13) << std::endl;   // 錯誤：應為 6227020800，實際溢位
    return 0;
}
