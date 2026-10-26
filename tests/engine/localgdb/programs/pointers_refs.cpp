#include <iostream>
using namespace std;

void SWAP(int* a, int* b) {
    int t = *a;
    *a = *b;
    *b = t;
}

void RSWAP(int& a, int& b) {
    int t = a;
    a = b;
    b = t;
}

int main() {
    int x = 10, y = 20;
    int* none = nullptr;
    SWAP(&x, &y);
    RSWAP(x, y);
    int* p = &x;
    *p = 5;
    return 0;
}
