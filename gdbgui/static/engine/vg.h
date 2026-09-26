// vgdb probe header (S1). Force-included into instrumented programs (via PCH or -include vg.h).
//
// Every probe call serialises "the stop at line L of function F" plus the variables in scope and
// writes ONE newline-terminated JSON record to WASI fd 3 — the dedicated trace channel. It never
// touches stdout/stderr, so ordinary program output (cout/cerr/printf/puts) cannot be mistaken for
// trace records. The host (exec.worker.js) routes fd 3 into its own capped buffer, and trace.js
// validates every record strictly. See README.md "Trace channel" for the residual risk.
//
// Record: {"p":P,"line":L,"fn":"F","depth":D,"frame":S,"n":[names in scope],"d":{changed values}}
//   p  : probe-site id; the host holds the static facts of every site (line, function, expected
//        names, uninitialised-variable bookkeeping) and rejects records that do not match them
//   n  : every variable name visible at this stop (delta encoding: only changed values are in d)
//   d  : name -> JSON value, only for values that differ from the last record of the same (F, name)
//   depth/frame : call depth and a unique serial per function activation (recursion-safe)
// Limit record: {"limit":"steps"} or {"limit":"bytes"}, then exit(124).
#pragma once
#include "vgcompat.h"
#include <wasi/api.h>

#include <array>
#include <cstdio>
#include <cstdlib>
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

#ifndef VG_MAX_STEPS
#define VG_MAX_STEPS 200000LL
#endif
#ifndef VG_MAX_BYTES
#define VG_MAX_BYTES 20000000LL
#endif

namespace __vg {

struct Var {
  const char* name;
  std::string json;
  long long cap = -1;  // std::vector capacity(); -1 = none. The container view draws spare slots from it.
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

// JSON string escaping. Used for EVERY string that reaches the trace: values, variable names and
// function names (a user-defined literal operator is literally named operator""_x).
inline std::string quote(const char* s, std::size_t n) {
  std::string o = "\"";
  for (std::size_t i = 0; i < n; ++i) {
    unsigned char c = static_cast<unsigned char>(s[i]);
    if (c == '"') o += "\\\"";
    else if (c == '\\') o += "\\\\";
    else if (c == '\n') o += "\\n";
    else if (c < 0x20 || c == 0x7f) { char b[8]; std::snprintf(b, sizeof b, "\\u%04x", c); o += b; }
    else o += static_cast<char>(c);
  }
  return o + "\"";
}
inline std::string quote(const std::string& s) { return quote(s.data(), s.size()); }
inline std::string quote(const char* s) { std::size_t n = 0; while (s[n]) ++n; return quote(s, n); }

template <class T> std::string j(const T& x) {
  if constexpr (std::is_same_v<T, bool>) {
    return x ? "1" : "0";
  } else if constexpr (std::is_floating_point_v<T>) {
    double d = static_cast<double>(x);
    if (__builtin_isnan(d)) return "\"nan\"";
    if (__builtin_isinf(d)) return d > 0 ? "\"inf\"" : "\"-inf\"";
    char b[40]; std::snprintf(b, sizeof b, "%.17g", d); return b;
  } else if constexpr (std::is_integral_v<T> && std::is_unsigned_v<T>) {
    return std::to_string(static_cast<unsigned long long>(x));
  } else if constexpr (std::is_arithmetic_v<T>) {
    return std::to_string(static_cast<long long>(x));
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
  } else if constexpr (std::is_same_v<T, std::vector<bool>>) {
    std::string o = "[";
    for (std::size_t i = 0; i < x.size(); ++i) { if (i) o += ","; o += x[i] ? "1" : "0"; }
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

// Call depth and activation serial. The instrumenter puts `__vg::Frame __vg_fr;` first in every
// instrumented function body, so each probe knows which activation (recursion level) it is in.
struct FrameState { long long depth = 0, cur = 0, next = 0; };
inline FrameState& frames() { static FrameState f; return f; }
struct Frame {
  long long prev;
  Frame() { FrameState& f = frames(); prev = f.cur; f.cur = ++f.next; ++f.depth; }
  ~Frame() { FrameState& f = frames(); f.cur = prev; --f.depth; }
  Frame(const Frame&) = delete;
  Frame& operator=(const Frame&) = delete;
};

// The trace channel: one fd_write per record, straight to fd 3 (no stdio buffering, so a record
// is never lost when the program later traps or is killed).
inline void emit(const std::string& s) {
  __wasi_ciovec_t io{reinterpret_cast<const uint8_t*>(s.data()), s.size()};
  __wasi_size_t n = 0;
  (void)__wasi_fd_write(3, &io, 1, &n);
}

// Delta encoding: remember the last JSON emitted per (function, name); only changed values go in "d".
inline std::map<std::string, std::string>& last() {
  static std::map<std::string, std::string> m;
  return m;
}

inline void step(int probe, int line, const char* fn, std::initializer_list<Var> vars) {
  static long long steps = 0, bytes = 0;
  const std::string qfn = quote(fn);
  std::string names = "[", diff = "{";
  bool firstName = true, firstDiff = true;
  auto add = [&](const std::string& name, const std::string& json) {
    if (!firstName) names += ",";
    firstName = false;
    const std::string qn = quote(name);
    names += qn;
    std::string& prev = last()[std::string(fn) + "\x1f" + name];
    if (prev != json) {
      prev = json;
      if (!firstDiff) diff += ",";
      firstDiff = false;
      diff += qn + ":" + json;
    }
  };
  for (const auto& x : vars) {
    add(x.name, x.json);
    if (x.cap >= 0) add(std::string(x.name) + ".capacity()", std::to_string(x.cap));  // pseudo variable
  }
  std::string o = "{\"p\":" + std::to_string(probe) + ",\"line\":" + std::to_string(line) + ",\"fn\":" + qfn +
                  ",\"depth\":" + std::to_string(frames().depth) + ",\"frame\":" + std::to_string(frames().cur) +
                  ",\"n\":" + names + "],\"d\":" + diff + "}}\n";
  // Safety limits: runaway loops / recursion stop with a marker the host turns into a clear message.
  if (++steps > VG_MAX_STEPS) { emit("{\"limit\":\"steps\"}\n"); std::exit(124); }
  if ((bytes += static_cast<long long>(o.size())) > VG_MAX_BYTES) { emit("{\"limit\":\"bytes\"}\n"); std::exit(124); }
  emit(o);
}

// `return X;` becomes `return __vg::ret(X, [&]{ probe at the closing brace; });`: X is evaluated
// first, then the `}` stop is recorded, then the value is returned (GDB stops at `}` after X).
template <class T, class F> T&& ret(T&& x, F&& f) { f(); return std::forward<T>(x); }

}  // namespace __vg
