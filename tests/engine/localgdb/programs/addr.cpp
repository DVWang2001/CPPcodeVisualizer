int f(int a) { return a + 1; }
int g(int a) { return a * 2; }
int main() {
    int s = 0;
    for (int i = 0; i < 2; ++i) {
        for (int j = 0; j < 2; ++j) {
            s += f(g(i)) + f(j);
        }
    }
    return s;
}
