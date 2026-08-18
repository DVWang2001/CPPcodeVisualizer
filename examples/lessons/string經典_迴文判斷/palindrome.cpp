#include <iostream>
#include <string>
#include <algorithm>
using namespace std;

bool isPalindrome(string s) {
    int left = 0;
    int right = s.length() - 1;
    
    while (left < right) {
        if (s[left] != s[right]) {
            return false;
        }
        left++;
        right--;
    }
    return true;
}

int main() {
    string s;
    while (cin >> s) {
        if (isPalindrome(s)) cout << "Yes" << endl;
        else cout << "No" << endl;
    }
    return 0;
}
