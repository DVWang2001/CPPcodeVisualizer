#include <iostream>
#include <string>
#include <utility>
#include <vector>
struct Pt { int a; int b; };
int fact(int n) {
    if (n <= 1) return 1;
    int r = n * fact(n - 1);
    return r;
}
void fill(std::vector<int>& v, int n) {
    for (int i = 0; i < n; ++i) v.push_back(i * i);
}
int main() {
    int x = fact(3);
    std::vector<int> v;
    fill(v, 3);
    std::vector<std::vector<int>> g(2, std::vector<int>(2, 7));
    std::string s = "hi";
    double d = 0.1;
    bool b = true;
    char c = 'a';
    long long big = 1234567890123LL;
    std::pair<int, int> m;
    m.first = 2;
    int arr[3] = {1, 2, 3};
    int* p = &x;
    Pt pt = {1, 2};
    int y = 0;
    for (int i = 0; i < 3; ++i) {
        y += i;
    }
    std::cout << x << " " << v.size() << " " << *p << "\n";
    return 0;
}
