#include <iostream>
bool pal(int x) {
    int y = x;
    return y == 3;
}
int main() {
    int s = 3;
    if (pal(s)) std::cout << "Y" << std::endl;
    for (int i = 0; i < 2; ++i) {
        s += pal(i) ? 1 : 0;
    }
    int k = 0;
    while (k < 3) {
        k++;
    }
    return 0;
}
