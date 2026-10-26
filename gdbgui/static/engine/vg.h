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

#include <algorithm>
#include <array>
#include <cstdio>
#include <cstdlib>
#include <deque>
#include <initializer_list>
#include <iterator>
#include <list>
#include <memory>
#include <map>
#include <queue>
#include <set>
#include <stack>
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
  // Scalar pointers and references (README "Pointers and references"): `addr` is the variable's own address (for a
  // reference: the referent's), `tgt` the pointee of a pointer. step() maps both back to a traced variable of a live frame.
  const void* addr = nullptr;
  const void* tgt = nullptr;
  int kind = 0;  // 0 plain, 1 object pointer
  bool ref = false;   // declared as a reference (vd): the trace says which traced variable it aliases
  bool reg = false;   // an arithmetic variable: the only kind a pointer / reference can be matched to (an array or struct shares its first element's / member's address)
  bool glob = false;  // a global: registered under frame 0, not under whichever frame happened to run the probe
  std::string (*rd)(const void*) = nullptr;  // pointer to an arithmetic type: serialises the pointee found at `tgt` (only called for a registered, live target)
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

// std::stack/std::queue/std::priority_queue are container ADAPTORS: no begin()/end(), so has_iter is
// false for them and they'd otherwise fall through j()'s default "<?>" case. Matched by exact
// template head (not just "has top()+push()+pop()").
template <class T> struct is_stack : std::false_type {};
template <class T, class C> struct is_stack<std::stack<T, C>> : std::true_type {};
template <class T> struct is_queue : std::false_type {};
template <class T, class C> struct is_queue<std::queue<T, C>> : std::true_type {};
template <class T> struct is_priority_queue : std::false_type {};
template <class T, class C, class Cmp> struct is_priority_queue<std::priority_queue<T, C, Cmp>> : std::true_type {};

// User class templates (instrument.js, registerClassTemplate): the instrumenter appends one partial specialisation of
// UserJ per class template, valid for every T; j() uses it when it exists. (A class WITHOUT template parameters gets a
// full specialisation of j itself.)
template <class T> struct UserJ;
template <class T, class = void> struct has_userj : std::false_type {};
template <class T> struct has_userj<T, std::void_t<decltype(sizeof(UserJ<T>))>> : std::true_type {};

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
  } else if constexpr (has_userj<T>::value) {
    return UserJ<T>::emit(x);
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
  } else if constexpr (is_stack<T>::value) {
    // top() is the last-pushed element; GDB shows the wrapped deque bottom-to-top (push order), so
    // draining top()-first and reversing recovers that order without touching the original.
    T c = x;
    std::vector<typename T::value_type> tmp;
    while (!c.empty()) { tmp.push_back(c.top()); c.pop(); }
    std::reverse(tmp.begin(), tmp.end());
    return j(tmp);
  } else if constexpr (is_queue<T>::value) {
    // front() first is already the wrapped deque's front-to-back order GDB shows.
    T c = x;
    std::vector<typename T::value_type> tmp;
    while (!c.empty()) { tmp.push_back(c.front()); c.pop(); }
    return j(tmp);
  } else if constexpr (is_priority_queue<T>::value) {
    // ponytail: top()-first drain gives priority order, not GDB's raw internal heap-array layout —
    // fine for the simplified sorted-list visualization, not a byte-match of real GDB's value string.
    T c = x;
    std::vector<typename T::value_type> tmp;
    while (!c.empty()) { tmp.push_back(c.top()); c.pop(); }
    return j(tmp);
  } else if constexpr (has_iter<T>::value) {
    // Generic iteration also covers std::set/map/multiset/multimap/unordered_* for free: each element
    // is either a scalar (set) or a std::pair (map, matched by is_pair above), no special-casing needed.
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
  Var r{name, j(x), cap};
  r.addr = (const void*)std::addressof(x);  // C-style: also accepts a volatile variable
  // arithmetic variables and object pointers (a reference to a pointer, `int*& r`, writes the caller's pointer)
  r.reg = std::is_arithmetic_v<std::remove_cv_t<T>> || (std::is_pointer_v<T> && std::is_object_v<std::remove_pointer_t<T>>);
  if constexpr (std::is_pointer_v<T> && std::is_object_v<std::remove_pointer_t<T>>) {
    r.kind = 1;
    r.tgt = (const void*)x;  // C-style: also drops a `volatile` pointee
    using P = std::remove_cv_t<std::remove_pointer_t<T>>;
    if constexpr (std::is_arithmetic_v<P>) r.rd = [](const void* p) -> std::string { return j(*static_cast<const P*>(p)); };
  }
  return r;
}
// Same, for a name whose DECLARED type is `D` (decltype(name)): a reference is traced like a normal variable (its value
// is the referent's) plus the pseudo variable `name.ref()` that says which traced variable it aliases.
template <class D, class T> Var vd(const char* name, const T& x) {
  Var r = v(name, x);
  if constexpr (std::is_reference_v<D>) r.ref = true;
  return r;
}
// A global (instrument.js knows which names are globals and not shadowed).
template <class D, class T> Var vdg(const char* name, const T& x) {
  Var r = vd<D>(name, x);
  r.glob = true;
  return r;
}

// Call depth and activation serial. The instrumenter puts `__vg::Frame __vg_fr;` first in every
// instrumented function body, so each probe knows which activation (recursion level) it is in.
// `cur` is a real stack, not a single "previous value" int, because a constructor's probes must
// already be inside the NEW activation while its member-initializer-list is still running -- that
// runs before the body's `{`, so nothing can declare a body-scoped `Frame` local yet. The
// instrumenter instead calls pushFrame() bare, from inside the first initializer clause, and pairs
// it with a FrameGuard (pop-only) declared once the body opens. A single-int "previous value" would
// not survive a nested constructor call made from a LATER clause of the same initializer-list
// pushing and popping its own frame first; a real stack does, by construction (LIFO, same as the
// actual C++ call stack).
struct FrameState { long long depth = 0, next = 0; std::vector<long long> stk; };
inline FrameState& frames() { static FrameState f; return f; }
inline long long curFrame() { auto& s = frames().stk; return s.empty() ? 0 : s.back(); }
// Address registry of the traced variables of the live frames: address -> (frame serial, name). A pointer variable's
// target and a reference's referent are looked up here, so the trace can say "p points to x of frame 1" instead of an
// opaque placeholder. Entries die with their frame (the address may be reused by the next call).
struct Registry {
  std::map<const void*, std::pair<long long, std::string>> by;
  std::map<long long, std::vector<const void*>> mine;
};
inline Registry& registry() { static Registry r; return r; }
inline void pushFrame() { FrameState& f = frames(); f.stk.push_back(++f.next); ++f.depth; }
inline void popFrame() {
  FrameState& f = frames();
  Registry& r = registry();
  auto it = r.mine.find(f.stk.back());
  if (it != r.mine.end()) { for (const void* a : it->second) { auto b = r.by.find(a); if (b != r.by.end() && b->second.first == f.stk.back()) r.by.erase(b); } r.mine.erase(it); }
  f.stk.pop_back();
  --f.depth;
}
struct Frame {
  Frame() { pushFrame(); }
  ~Frame() { popFrame(); }
  Frame(const Frame&) = delete;
  Frame& operator=(const Frame&) = delete;
};
// A constructor's frame is pushed early (see above); FrameGuard just pops it at scope exit,
// mirroring Frame's RAII without pushing a second time.
struct FrameGuard {
  FrameGuard(const FrameGuard&) = delete;
  FrameGuard& operator=(const FrameGuard&) = delete;
  FrameGuard() = default;
  ~FrameGuard() { popFrame(); }
};

// Derived classes with a user constructor or destructor get one unique empty first base, `Pre<N>` (instrument.js,
// registerClass). Bases are constructed first and destroyed last, so:
//  * its mem-initialiser, put first in the constructor's initialiser list, is the earliest code of the construction and
//    pushes the constructor's frame before any base constructor (itself traced) runs;
//  * its destructor is the latest code of the destruction: the destructor's frame (DtorFrame, opened in the destructor
//    body) is closed there, after every member and base destructor ran inside it.
// Names of template instantiations (instrument.js, registerFunctionTemplate): the instrumenter appends one explicit
// specialisation `TplName<ID, args...>` per instantiation it saw; a template body, shared by all of them, asks for its own.
template <int ID, class... Ts> struct TplName;

inline std::vector<const void*>& pendingDtors() { static std::vector<const void*> v; return v; }
template <int N> struct Pre {
  Pre() {}
  explicit Pre(int) {}
  ~Pre() {
    auto& st = pendingDtors();
    if (!st.empty() && st.back() == this) { st.pop_back(); popFrame(); }
  }
};
struct DtorFrame {
  template <int N> explicit DtorFrame(Pre<N>* p) { pushFrame(); pendingDtors().push_back(p); }
  DtorFrame(const DtorFrame&) = delete;
  DtorFrame& operator=(const DtorFrame&) = delete;
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
  // Register this stop's variables first (a pointer may point at a variable declared later in the same list).
  {
    Registry& rg = registry();
    const long long cf = curFrame();
    for (const auto& x : vars) {
      if (!x.addr || x.ref || !x.reg) continue;  // a reference shares its referent's address (the referent owns it); non-arithmetic variables are never targets
      const long long fr = x.glob ? 0 : cf;
      auto ins = rg.by.emplace(x.addr, std::make_pair(fr, std::string(x.name)));
      if (ins.second) rg.mine[fr].push_back(x.addr);
      else if (ins.first->second.first == fr) ins.first->second.second = x.name;  // same frame, new block variable at that address
    }
  }
  for (const auto& x : vars) {
    if (x.kind == 1 && x.tgt) {
      auto f = registry().by.find(x.tgt);
      if (f != registry().by.end()) {
        // {"__vgp":"frame:name"[,"__vgv":pointee value]}: `__vgv` is the pointee as it is NOW (it may change while only the pointer's
        // frame is running, e.g. `*a = *b` inside SWAP), so it is re-read at every stop of the pointer's frame.
        add(x.name, "{\"__vgp\":" + quote(std::to_string(f->second.first) + ":" + f->second.second) + (x.rd ? ",\"__vgv\":" + x.rd(x.tgt) : std::string()) + "}");
      } else add(x.name, x.json);
    } else {
      add(x.name, x.json);
    }
    if (x.cap >= 0) add(std::string(x.name) + ".capacity()", std::to_string(x.cap));  // pseudo variable
    if (x.ref && x.addr) {
      auto f = registry().by.find(x.addr);
      if (f != registry().by.end()) add(std::string(x.name) + ".ref()", quote(std::to_string(f->second.first) + ":" + f->second.second));
    }
  }
  std::string o = "{\"p\":" + std::to_string(probe) + ",\"line\":" + std::to_string(line) + ",\"fn\":" + qfn +
                  ",\"depth\":" + std::to_string(frames().depth) + ",\"frame\":" + std::to_string(curFrame()) +
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
