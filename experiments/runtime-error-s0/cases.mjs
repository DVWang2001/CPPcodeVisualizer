// Spike cases: classic student runtime errors. Each: id, label (zh), src, stdin.
const H = "#include <bits/stdc++.h>\nusing namespace std;\n";
export const CASES = [
  { id: "div0_input", label: "整數除以零（值來自輸入）", stdin: "7 0", src: H + `int main() {
  int a, b;
  cin >> a >> b;
  int c = a / b;
  cout << c << endl;
  return 0;
}` },
  { id: "div0_const", label: "整數除以零（值在程式裡）", stdin: "", src: H + `int main() {
  int a = 7, b = 0;
  int c = a / b;
  cout << c << endl;
  return 0;
}` },
  { id: "div0_unused", label: "整數除以零（結果沒被用到）", stdin: "", src: H + `int main() {
  int a = 7, b = 0;
  int c = a / b;
  cout << "done" << endl;
  return 0;
}` },
  { id: "mod0_loop", label: "取餘數 % 0（迴圈第一圈）", stdin: "", src: H + `int main() {
  for (int i = 0; i < 3; i++) {
    cout << 10 % i << endl;
  }
  return 0;
}` },
  { id: "intmin_div", label: "INT_MIN / -1", stdin: "-2147483648 -1", src: H + `int main() {
  int a, b;
  cin >> a >> b;
  cout << a / b << endl;
  return 0;
}` },
  { id: "ovf_add", label: "有號整數溢位（加法）", stdin: "", src: H + `int main() {
  int x = 2147483647;
  x = x + 1;
  cout << x << endl;
  return 0;
}` },
  { id: "ovf_fact", label: "有號整數溢位（階乘）", stdin: "", src: H + `int main() {
  int f = 1;
  for (int i = 1; i <= 20; i++) {
    f = f * i;
  }
  cout << f << endl;
  return 0;
}` },
  { id: "ovf_loop", label: "溢位造成的迴圈（i *= 2 直到變負）", stdin: "", src: H + `int main() {
  int cnt = 0;
  for (int i = 1; i > 0; i = i * 2) {
    cnt++;
  }
  cout << cnt << endl;
  return 0;
}` },
  { id: "arr_oob_write", label: "陣列越界寫入（i <= 5）", stdin: "", src: H + `int main() {
  int a[5];
  int total = 100;
  for (int i = 0; i <= 5; i++) {
    a[i] = i * 10;
  }
  cout << a[0] << " " << total << endl;
  return 0;
}` },
  { id: "arr_oob_read", label: "陣列越界讀取（索引來自輸入）", stdin: "7", src: H + `int main() {
  int a[5] = {1, 2, 3, 4, 5};
  int i;
  cin >> i;
  cout << a[i] << endl;
  return 0;
}` },
  { id: "arr2d_oob", label: "二維陣列欄越界", stdin: "", src: H + `int main() {
  int g[3][3] = {};
  int r = 1, c = 3;
  g[r][c] = 9;
  cout << g[2][0] << endl;
  return 0;
}` },
  { id: "vec_oob", label: "vector[] 越界（i <= 5）", stdin: "", src: H + `int main() {
  vector<int> v(5);
  for (int i = 0; i <= 5; i++) {
    v[i] = i;
  }
  cout << v.size() << endl;
  return 0;
}` },
  { id: "vec_at", label: "vector.at() 越界", stdin: "", src: H + `int main() {
  vector<int> v(3);
  cout << v.at(5) << endl;
  return 0;
}` },
  { id: "vec_empty_back", label: "空 vector 的 back()", stdin: "", src: H + `int main() {
  vector<int> v;
  cout << v.back() << endl;
  return 0;
}` },
  { id: "vec_pop_empty", label: "空 vector 的 pop_back()", stdin: "", src: H + `int main() {
  vector<int> v;
  v.pop_back();
  cout << v.size() << endl;
  return 0;
}` },
  { id: "stack_empty_top", label: "空 stack 的 top()", stdin: "", src: H + `int main() {
  stack<int> s;
  s.push(1);
  s.pop();
  cout << s.top() << endl;
  return 0;
}` },
  { id: "queue_empty_front", label: "空 queue 的 front()", stdin: "", src: H + `int main() {
  queue<int> q;
  cout << q.front() << endl;
  return 0;
}` },
  { id: "str_oob", label: "string[] 越界", stdin: "", src: H + `int main() {
  string s = "abc";
  cout << s[10] << endl;
  return 0;
}` },
  { id: "substr_throw", label: "substr 起點超出長度", stdin: "", src: H + `int main() {
  string s = "abc";
  cout << s.substr(5) << endl;
  return 0;
}` },
  { id: "null_write", label: "空指標寫入", stdin: "", src: H + `int main() {
  int* p = nullptr;
  *p = 5;
  cout << "after" << endl;
  return 0;
}` },
  { id: "null_read", label: "空指標讀取", stdin: "", src: H + `int main() {
  int* p = nullptr;
  int x = *p;
  cout << x << endl;
  return 0;
}` },
  { id: "missing_return", label: "函式沒有回傳值（x == 0）", stdin: "", src: H + `int sign(int x) {
  if (x > 0) return 1;
  if (x < 0) return -1;
}
int main() {
  cout << sign(0) << endl;
  return 0;
}` },
  { id: "uninit_read", label: "使用未初始化變數", stdin: "", src: H + `int main() {
  int sum;
  for (int i = 1; i <= 3; i++) {
    sum += i;
  }
  cout << sum << endl;
  return 0;
}` },
  { id: "inf_recursion", label: "無窮遞迴（沒有終止條件）", stdin: "", src: H + `int f(int n) {
  return f(n - 1) + 1;
}
int main() {
  cout << f(3) << endl;
  return 0;
}` },
  { id: "deep_recursion", label: "合法但很深的遞迴（5000 層）", stdin: "5000", src: H + `int f(int n) {
  if (n == 0) return 0;
  return f(n - 1) + 1;
}
int main() {
  int n;
  cin >> n;
  cout << f(n) << endl;
  return 0;
}` },
  { id: "shift_big", label: "位移量超過 31", stdin: "33", src: H + `int main() {
  int s;
  cin >> s;
  cout << (1 << s) << endl;
  return 0;
}` },
  { id: "float2int", label: "double 轉 int 超出範圍", stdin: "", src: H + `int main() {
  double d = 1e10;
  int x = d;
  cout << x << endl;
  return 0;
}` },
  { id: "assert_fail", label: "assert 失敗", stdin: "", src: H + `int main() {
  int x = -3;
  assert(x > 0);
  cout << "after" << endl;
  return 0;
}` },
  { id: "double_delete", label: "重複 delete", stdin: "", src: H + `int main() {
  int* p = new int(5);
  delete p;
  delete p;
  cout << "after" << endl;
  return 0;
}` },
  { id: "use_after_free", label: "delete 後再使用", stdin: "", src: H + `int main() {
  int* p = new int(5);
  delete p;
  *p = 7;
  cout << *p << endl;
  return 0;
}` },
  { id: "unsigned_wrap", label: "size()-1 在空 vector 變成極大值", stdin: "", src: H + `int main() {
  vector<int> v;
  for (size_t i = 0; i <= v.size() - 1; i++) {
    cout << v[i] << endl;
  }
  return 0;
}` },
  { id: "cin_fail", label: "輸入不夠（cin 失敗）", stdin: "", src: H + `int main() {
  int n;
  cin >> n;
  cout << n * 2 << endl;
  return 0;
}` },
  { id: "sort_bad_cmp", label: "sort 比較函式用 <=", stdin: "", src: H + `int main() {
  vector<int> v(40, 5);
  sort(v.begin(), v.end(), [](int a, int b) { return a <= b; });
  cout << v[0] << endl;
  return 0;
}` },
  { id: "iter_invalid", label: "range-for 中 push_back（迭代器失效）", stdin: "", src: H + `int main() {
  vector<int> v = {1, 2, 3};
  for (int x : v) {
    if (x == 2) v.push_back(4);
  }
  cout << v.size() << endl;
  return 0;
}` },
];
