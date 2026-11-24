// Runtime-error corpus (41 programs) = cases_s0.mjs + 7 additions, copied unchanged from the S0 measurement
// (experiments/runtime-error-s0/cases_v2.mjs). Same shape: id, label, stdin, src.
import { CASES as BASE } from "./cases_s0.mjs";
const H = "#include <bits/stdc++.h>\nusing namespace std;\n";
export const CASES = [
  ...BASE,
  { id: "sort_user_cmp", label: "正確程式：sort 搭配使用者比較函式（檢查不應改變軌跡）", stdin: "", src: H + `bool cmp(int a, int b) {
  return a > b;
}
int main() {
  vector<int> v = {5, 3, 8, 1, 9, 2, 7, 4, 6, 0, 11, 15, 13, 12, 14};
  sort(v.begin(), v.end(), cmp);
  cout << v[0] << " " << v[14] << endl;
  return 0;
}` },
  { id: "float_div_zero", label: "浮點數除以零（不是 UB，結果是 inf）", stdin: "", src: H + `int main() {
  double z = 0;
  double r = 1.0 / z;
  cout << r << endl;
  return 0;
}` },
  { id: "abort_call", label: "程式自己呼叫 abort()", stdin: "", src: H + `int main() {
  int x = 1;
  if (x == 1) abort();
  cout << "after" << endl;
  return 0;
}` },
  { id: "huge_vector", label: "vector 要求的記憶體超過上限（bad_alloc）", stdin: "", src: H + `int main() {
  vector<int> v(600000000);
  cout << v.size() << endl;
  return 0;
}` },
  { id: "vla_neg", label: "int a[n] 的 n 是負數（n 來自輸入）", stdin: "-3", src: H + `int main() {
  int n;
  cin >> n;
  int a[n];
  a[0] = 1;
  cout << a[0] << endl;
  return 0;
}` },
  { id: "stoi_bad", label: "stoi 轉換非數字字串", stdin: "", src: H + `int main() {
  string s = "abc";
  int x = stoi(s);
  cout << x << endl;
  return 0;
}` },
  { id: "mod0_input", label: "取餘數 % 0（值來自輸入）", stdin: "10 0", src: H + `int main() {
  int a, b;
  cin >> a >> b;
  cout << a % b << endl;
  return 0;
}` },
];
