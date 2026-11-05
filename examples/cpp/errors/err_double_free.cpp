// 錯誤教案 #6：淺拷貝導致重複釋放（double free）
// BUG：Buffer 有指標成員，但沒有定義拷貝建構子；b = a 只複製了指標位址，
//      兩個物件的解構子都會 delete 同一塊記憶體，結束時重複釋放而崩潰。
// 學生常見想法：「= 就是把資料全部複製過去」。
// 修正：定義深拷貝建構子與指定運算子，或改用 std::vector<int>。
#include <iostream>

class Buffer {
public:
    explicit Buffer(int n) : data_(new int[n]), n_(n) {}
    ~Buffer() { delete[] data_; }   // 兩個物件都會執行這一行
    int* data_;
    int n_;
};

int main() {
    Buffer a(3);
    a.data_[0] = 1;
    Buffer b = a;                   // BUG：淺拷貝，b.data_ 與 a.data_ 指向同一塊記憶體
    std::cout << "b.data_[0] = " << b.data_[0] << std::endl;
    return 0;                       // 離開 main 時 b、a 依序解構，重複 delete
}
