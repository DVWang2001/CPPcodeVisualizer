// vgdb E2 探針：把「停駐點的行號＋作用域內變數」序列化成 JSON，寫到 stderr（前綴 \x01VG）。
// 容器只靠標準的 begin()/end() 走訪，不依賴 libc++／libstdc++ 的內部記憶體配置。
#pragma once
#include <array>
#include <cstdio>
#include <deque>
#include <initializer_list>
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
};

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

template <class T> Var v(const char* name, const T& x) { return Var{name, j(x)}; }

inline void step(int line, const char* fn, std::initializer_list<Var> vars) {
  std::string o = "\x01VG{\"line\":" + std::to_string(line) + ",\"fn\":\"" + fn + "\",\"vars\":{";
  bool first = true;
  for (const auto& v : vars) {
    if (!first) o += ",";
    first = false;
    o += quote(v.name) + ":" + v.json;
  }
  o += "}}\n";
  std::fputs(o.c_str(), stderr);
}


// return X; 的轉換：先算出 X，再執行「函式結尾 `}`」那一站的探針，最後才真的回傳。
template <class T, class F> T&& ret(T&& x, F&& f) { f(); return std::forward<T>(x); }

}  // namespace __vg
