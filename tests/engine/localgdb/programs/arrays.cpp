#include <iostream>
#include <string>
#include <vector>
int g[4] = {1, 2, 3, 4};
int main() {
    int a[3] = {5, 6, 7};
    int m[2][3] = {{1, 2, 3}, {4, 5, 6}};
    int z[15] = {9};
    int big[250];
    for (int i = 0; i < 250; ++i) big[i] = i;
    char s[10] = "ab";
    double d[2] = {0.5, 1.25};
    bool f[2] = {true, false};
    long long L[2] = {1234567890123LL, -1};
    std::string names[2] = {"x", "yz"};
    std::vector<int> vs[2] = {std::vector<int>(2, 3), std::vector<int>()};
    int cand[3];
    for (int k = 0; k < 3; ++k) cand[k] = a[k] + g[k];
    a[1] = 60;
    std::cout << cand[2] << "\n";
    return 0;
}
