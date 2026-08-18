#include <iostream>
using namespace std;
void SWAP(int a,int b) {
    int t = a;
    a = b;
    b = t;
}
int main() {
    int a,b; cin >> a >> b;
    SWAP(a,b);
}