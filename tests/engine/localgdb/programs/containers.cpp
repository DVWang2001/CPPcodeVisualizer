#include <deque>
#include <list>
#include <map>
#include <queue>
#include <set>
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
    std::priority_queue<int> pq;
    pq.push(3);
    pq.push(1);
    pq.push(4);
    std::set<int> st = {3, 1, 2};
    std::map<int, int> mp;
    mp[1] = 10;
    mp[2] = 20;
    dq.push_back(4);
    ls.pop_front();
    sk.push(9);
    qu.pop();
    pq.push(5);
    st.insert(0);
    mp[3] = 30;
    return 0;
}
