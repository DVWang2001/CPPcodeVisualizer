#include <vector>
#include <string>
#include <array>
#include <set>
static void f(std::vector<int>& nv, const std::vector<int>& cv, std::string& ns, const std::string& cs,
              std::array<int,3>& na, std::set<int>& nset, int& ni, const int& ci) {
    volatile int x = 0; (void)x;
}
int main() {
    std::vector<int> v = {1,2,3}; std::string s = "hi"; std::array<int,3> a = {1,2,3}; std::set<int> st = {5,3};
    int i = 7;
    f(v, v, s, s, a, st, i, i);
    return 0;
}
