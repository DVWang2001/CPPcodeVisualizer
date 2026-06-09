#include <vector>
#include <array>
#include <string>
#include <list>
#include <stack>
#include <queue>
#include <deque>
#include <set>
#include <map>
#include <unordered_map>

static void e2e_bp(
    const std::vector<int>&                v,
    const std::array<int, 3>&              a,
    const std::string&                     s,
    const std::list<int>&                  l,
    const std::stack<int>&                 st,
    const std::queue<int>&                 q,
    const std::deque<int>&                 dq,
    const std::set<int>&                   se,
    const std::multiset<int>&              ms,
    const std::map<int, std::string>&      m,
    const std::multimap<int, std::string>& mm,
    const std::unordered_map<int, int>&    um
) {
    volatile int x = 0; (void)x;
}

int main() {
    std::vector<int>                v  = {10, 20, 30};
    std::array<int, 3>              a  = {1, 2, 3};
    std::string                     s  = "hi";
    std::list<int>                  l  = {4, 5, 6};
    std::stack<int>                 st; st.push(1); st.push(2);
    std::queue<int>                 q;  q.push(7);  q.push(8);
    std::deque<int>                 dq = {9, 10};
    std::set<int>                   se = {5, 3, 7};
    std::multiset<int>              ms = {2, 2, 4};
    std::map<int, std::string>      m  = {{1, "a"}, {2, "b"}};
    std::multimap<int, std::string> mm = {{1, "x"}, {1, "y"}};
    std::unordered_map<int, int>    um = {{42, 99}};

    e2e_bp(v, a, s, l, st, q, dq, se, ms, m, mm, um);
    return 0;
}
