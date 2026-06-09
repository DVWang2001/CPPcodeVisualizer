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

// Stable GDB breakpoint target: `b e2e_bp`
static void e2e_bp() { volatile int x = 0; (void)x; }

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

    e2e_bp();   // GDB stops here — all containers populated
    return 0;
}
