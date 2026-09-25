// vgdb E2 探針：把「停駐點的行號＋作用域內變數」序列化成 JSON，寫到 stderr（前綴 \x01VG）。
// 容器只靠標準的 begin()/end() 走訪，不依賴 libc++／libstdc++ 的內部記憶體配置。
#pragma once
#include <array>
#include <cstdio>
#include <cstdlib>

#ifndef VG_MAX_STEPS
#define VG_MAX_STEPS 200000LL
#endif
#ifndef VG_MAX_BYTES
#define VG_MAX_BYTES 20000000LL
#endif
#include <deque>
#include <initializer_list>
#include <iterator>
#include <list>
#include <map>
#include <set>
#include <string>
#include <type_traits>
#include <utility>
#include <vector>

namespace __vg {

struct Var {
  const char* name;
  std::string json;
  long long cap = -1;  // std::vector 的 capacity()；-1 表示沒有。前端的容器視覺化會用它畫「超出長度的空格子」。
};

template <class T, class = void> struct has_capacity : std::false_type {};
template <class T>
struct has_capacity<T, std::void_t<decltype(std::declval<const T&>().capacity())>> : std::true_type {};

template <class T, class = void> struct has_iter : std::false_type {};
template <class T>
struct has_iter<T, std::void_t<decltype(std::declval<const T&>().begin()), decltype(std::declval<const T&>().end())>>
    : std::true_type {};

template <class T> struct is_pair : std::false_type {};
template <class A, class B> struct is_pair<std::pair<A, B>> : std::true_type {};

template <class T> std::string j(const T& x);

inline std::string quote(const std::string& s) {
  std::string o = "\"";
  for (unsigned char c : s) {
    if (c == '"') o += "\\\"";
    else if (c == '\\') o += "\\\\";
    else if (c == '\n') o += "\\n";
    else if (c < 0x20) { char b[8]; std::snprintf(b, sizeof b, "\\u%04x", c); o += b; }
    else o += static_cast<char>(c);
  }
  return o + "\"";
}

template <class T> std::string j(const T& x) {
  if constexpr (std::is_same_v<T, bool>) {
    return x ? "1" : "0";
  } else if constexpr (std::is_arithmetic_v<T>) {
    if constexpr (std::is_floating_point_v<T>) { char b[40]; std::snprintf(b, sizeof b, "%.17g", static_cast<double>(x)); return b; }
    else return std::to_string(static_cast<long long>(x));
  } else if constexpr (std::is_enum_v<T>) {
    return std::to_string(static_cast<long long>(x));
  } else if constexpr (std::is_same_v<T, std::string>) {
    return quote(x);
  } else if constexpr (is_pair<T>::value) {
    return "[" + j(x.first) + "," + j(x.second) + "]";
  } else if constexpr (std::is_array_v<T>) {
    std::string o = "[";
    for (std::size_t i = 0; i < std::extent_v<T>; ++i) { if (i) o += ","; o += j(x[i]); }
    return o + "]";
  } else if constexpr (has_iter<T>::value) {
    std::string o = "[";
    bool first = true;
    for (const auto& e : x) { if (!first) o += ","; first = false; o += j(e); }
    return o + "]";
  } else if constexpr (std::is_pointer_v<T>) {
    return x ? "\"<ptr>\"" : "0";
  } else {
    return "\"<?>\"";
  }
}

template <class T> Var v(const char* name, const T& x) {
  long long cap = -1;
  if constexpr (has_capacity<T>::value && !std::is_same_v<T, std::string>) cap = static_cast<long long>(x.capacity());
  return Var{name, j(x), cap};
}

// 差量記錄：每個 (函式, 變數名) 記住上一次輸出的 JSON，只輸出「跟上次不同」的變數，
// 並另外列出目前在作用域內的全部變數名（"n"）。解碼端用同樣的規則還原完整快照。
inline std::map<std::string, std::string>& last() {
  static std::map<std::string, std::string> m;
  return m;
}

inline void step(int line, const char* fn, std::initializer_list<Var> vars) {
  std::string names = "[", diff = "{";
  bool firstName = true, firstDiff = true;
  auto emit = [&](const std::string& name, const std::string& json) {
    if (!firstName) names += ",";
    firstName = false;
    names += quote(name);
    auto& prev = last()[std::string(fn) + "\x1f" + name];
    if (prev != json) {
      prev = json;
      if (!firstDiff) diff += ",";
      firstDiff = false;
      diff += quote(name) + ":" + json;
    }
  };
  for (const auto& v : vars) {
    emit(v.name, v.json);
    if (v.cap >= 0) emit(std::string(v.name) + ".capacity()", std::to_string(v.cap));  // 偽變數，求值器直接查表
  }
  std::string o = "\x01VG{\"line\":" + std::to_string(line) + ",\"fn\":\"" + fn + "\",\"n\":" + names + "],\"d\":" + diff + "}}\n";
  // 安全上限：步數或輸出量超過就中止程式（無窮迴圈、失控遞迴），並留下標記讓前端顯示原因。
  static long long steps = 0, bytes = 0;
  if (++steps > VG_MAX_STEPS || (bytes += static_cast<long long>(o.size())) > VG_MAX_BYTES) {
    std::fputs("\x01VGLIMIT\n", stderr);
    std::exit(124);
  }
  std::fputs(o.c_str(), stderr);
}


// return X; 的轉換：先算出 X，再執行「函式結尾 `}`」那一站的探針，最後才真的回傳。
template <class T, class F> T&& ret(T&& x, F&& f) { f(); return std::forward<T>(x); }

}  // namespace __vg
