#include <deque>
#include <list>
#include <queue>
#include <stack>
int main() {
    std::deque<int> dq = {1, 2, 3};
    std::list<int> ls = {4, 5, 6};
    std::stack<int> sk;
    sk.push(1);
    sk.push(2);
    sk.push(3);
    std::queue<int> qu;
    qu.push(1);
    qu.push(2);
    qu.push(3);
    std::deque<int> empty_dq;
    std::list<int> empty_ls;
    std::stack<int> one_sk;
    one_sk.push(5);
    dq.push_back(4);
    ls.pop_front();
    sk.push(9);
    qu.pop();
    return 0;
}
