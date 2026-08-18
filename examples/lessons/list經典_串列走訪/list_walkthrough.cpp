#include <iostream>
#include <list>
using namespace std;

int main() {
    list<int> mylist = {10, 20, 30};
    
    // 在開頭插入
    mylist.push_front(5);
    
    // 在結尾插入
    mylist.push_back(40);
    
    // 走訪並顯示
    for (int x : mylist) {
        cout << x << " ";
    }
    cout << endl;
    
    return 0;
}
