#include <iostream>
#include <stack>
#include <vector>
using namespace std;
int main() {
    int number,n;
    int Case = 0;
    string s;
    while (cin >> n && n != 0) {
        while (true) {
            if (Case++) cout << endl;
            vector<int>order;
            cin >> number;
            if (number == 0) {
                Case = 0;
                cout << endl;
                break;
            }
            order.push_back(number);
            int target = 1;
            int index = 0;
            for (int i = 0; i < n-1; i++) {
                cin >> number;
                order.push_back(number);
            }
            stack<int>train;
            for (int i = 1; i <= n; i++) {
                train.push(i);
                while (train.size() && train.top() == order[index]) {
                    train.pop();
                    index++;
                }
            }
            if (train.empty()) cout << "Yes";
            else               cout << "No";
        }
    }
}