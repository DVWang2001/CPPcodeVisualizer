#include <iostream>
using namespace std;

int G = 3;

void fill(int* a) {
    a[0] = 7;
    int t = 0;
}

void store5(int* q) {
    *q = 5;
    int t = 0;
}

void gset(int* g) {
    *g = 9;
    int t = 0;
}

int main() {
    int arr[3] = {1, 2, 3};
    fill(arr);
    int x = 1;
    int* p = &x;
    store5(p);
    gset(&G);
    return 0;
}
