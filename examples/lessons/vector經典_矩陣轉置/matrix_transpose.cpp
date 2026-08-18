#include <iostream>
#include <vector>
using namespace std;

int main() {
    int rows = 2, cols = 3;
    vector<vector<int>> matrix = {{1, 2, 3}, {4, 5, 6}};
    vector<vector<int>> transposed(cols, vector<int>(rows));

    for (int i = 0; i < rows; i++) {
        for (int j = 0; j < cols; j++) {
            transposed[j][i] = matrix[i][j];
        }
    }

    return 0;
}
