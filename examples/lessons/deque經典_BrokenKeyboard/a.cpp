#include <iostream>
#include <string>
#include <deque>
using namespace std;
int main() {
    string s;
    while (getline(cin,s)) {
        bool Home = false;
        deque<string>Deque;
        Deque.push_back("");
        for (auto&i:s) {
            if (i == '[') {
                Deque.push_front("");
                Home = true;
            }
            else if (i == ']') {
                Deque.push_back("");
                Home = false;
            }
            else {
                if (Home) {
                    Deque.front().push_back(i);
                }
                else {
                    Deque.back().push_back(i);
                }
            }
        }
        for (auto&i:Deque) cout << i;
        cout << endl;
    }
}