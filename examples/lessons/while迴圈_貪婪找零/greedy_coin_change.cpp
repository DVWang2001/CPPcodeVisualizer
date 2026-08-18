#include <iostream>
#include <vector>
using namespace std;

int main() {
    int amount = 63;
    vector<int> coins = {25, 10, 5, 1};
    vector<int> result;

    for (int coin : coins) {
        while (amount >= coin) {
            amount -= coin;
            result.push_back(coin);
        }
    }

    return 0;
}
