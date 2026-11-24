// vgdb runtime-error reports (runtime-error plan P1, docs/superpowers/plans/2026-11-23-runtime-error-viz-plan.md §3).
// Included at the end of vg.h, so it is part of every instrumented program (and of its PCH). It implements, inside the
// student's program:
//   * the UndefinedBehaviorSanitizer handler ABI (compiler-rt ubsan_handlers.h; the browser toolchain ships no
//     compiler-rt) for the checks pipeline.worker.js turns on with CHECK_FLAGS;
//   * __vg_libcxx_assert, called by the replacement include/c++/v1/__assertion_handler when a libc++ hardening check
//     (EXTENSIVE mode) fails, and std::__libcpp_verbose_abort (the -fno-exceptions "throw" of at(), substr(), stoi, ...);
//   * __assert_fail, the target of wasi-libc's assert().
// Every report is ONE error record on the fd-3 trace channel, written after the stop records of vg.h, e.g.
//   {"err":"div-by-zero","fatal":1,"file":"main.cpp","line":6,"col":13,"v":{"lhs":7,"rhs":0,"type":"'int'"}}
// line/col are clang's (the instrumented text keeps the original line numbers; trace.js maps col back through
// meta.cols). A fatal error (what natively crashes or aborts: decision 2 of the plan) ends the program with exit code
// 134 right after its record. A recoverable one (signed overflow, shift, C array bounds, float->int) is reported once
// per source location, for at most 64 locations, and the program goes on, so the trace shows what the bad value does
// next. trace.js validates every record (fixed fields, kind whitelist, value names, sizes). Handlers of checks that
// CHECK_FLAGS leaves out (alignment, object-size, pointer-overflow, nonnull) stay defined, so a build with them links.
#pragma once
#include <wasi/api.h>
#include <cmath>
#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <__verbose_abort>

extern "C" {
// compiler-rt ubsan_value.h / ubsan_handlers.h layouts (a C++ reference member is a pointer)
struct __vgLoc { const char* file; uint32_t line; uint32_t col; };
struct __vgTy { uint16_t kind; uint16_t info; char name[1]; };  // kind 0 integer (info = log2(bits) << 1 | signed), 1 float (info = bits)
typedef uintptr_t __vgVH;  // a value that fits in a pointer is passed inline, a wider one by address
struct __vgOvf { __vgLoc loc; const __vgTy* ty; };
struct __vgShift { __vgLoc loc; const __vgTy* lhsTy; const __vgTy* rhsTy; };
struct __vgOob { __vgLoc loc; const __vgTy* arrTy; const __vgTy* idxTy; };
struct __vgOnlyLoc { __vgLoc loc; };
struct __vgMismatch { __vgLoc loc; const __vgTy* ty; unsigned char logAlign; unsigned char tck; };
struct __vgFloatCast { __vgLoc loc; const __vgTy* from; const __vgTy* to; };
struct __vgInvalid { __vgLoc loc; const __vgTy* ty; };
struct __vgBuiltin { __vgLoc loc; unsigned char kind; };
struct __vgNonnullArg { __vgLoc loc; __vgLoc attr; int arg; };
}

#define VGNS __attribute__((no_sanitize("undefined")))
namespace __vgerr {

// A bounded text buffer for one record (no heap: the error may come from a corrupted program state).
struct Buf {
  char b[4096];
  size_t n = 0;
  VGNS void raw(const char* s) {
    while (*s && n + 1 < sizeof b) b[n++] = *s++;
    b[n] = 0;
  }
  // JSON string with quotes; quotes, backslashes and control characters escaped; at most `budget` output bytes
  VGNS void str(const char* s, size_t budget) {
    raw("\"");
    size_t used = 0;
    for (const unsigned char* c = reinterpret_cast<const unsigned char*>(s ? s : ""); *c && used + 6 < budget && n + 8 < sizeof b; ++c) {
      char tmp[8];
      if (*c == '"' || *c == '\\') { tmp[0] = '\\'; tmp[1] = static_cast<char>(*c); tmp[2] = 0; }
      else if (*c < 0x20) snprintf(tmp, sizeof tmp, "\\u%04x", *c);
      else { tmp[0] = static_cast<char>(*c); tmp[1] = 0; }
      used += strlen(tmp);
      raw(tmp);
    }
    raw("\"");
  }
  VGNS void key(const char* k) {
    if (n > 0 && b[n - 1] != '{') raw(",");
    raw("\"");
    raw(k);
    raw("\":");
  }
};

// Integer value as JSON: a number when a double holds it exactly, otherwise a decimal string.
VGNS inline void putInt(Buf& o, const char* k, const __vgTy* t, __vgVH v) {
  o.key(k);
  if (!t || t->kind != 0 || (t->info >> 1) > 6) { o.raw("null"); return; }
  const unsigned bits = 1u << (t->info >> 1);
  const bool sgn = t->info & 1;
  uint64_t u = 0;
  if (bits <= sizeof(__vgVH) * 8) u = static_cast<uint64_t>(v);
  else memcpy(&u, reinterpret_cast<const void*>(v), 8);
  char tmp[32];
  const unsigned long long safe = 9007199254740991ULL;  // 2^53 - 1
  if (sgn) {
    int64_t s = bits == 64 ? static_cast<int64_t>(u) : bits == 32 ? static_cast<int32_t>(static_cast<uint32_t>(u))
              : bits == 16 ? static_cast<int16_t>(static_cast<uint16_t>(u)) : static_cast<int8_t>(static_cast<uint8_t>(u));
    const bool exact = s >= -static_cast<int64_t>(safe) && s <= static_cast<int64_t>(safe);
    snprintf(tmp, sizeof tmp, exact ? "%lld" : "\"%lld\"", static_cast<long long>(s));
  } else {
    if (bits < 64) u &= (1ULL << bits) - 1;
    snprintf(tmp, sizeof tmp, u <= safe ? "%llu" : "\"%llu\"", static_cast<unsigned long long>(u));
  }
  o.raw(tmp);
}
VGNS inline void putFloat(Buf& o, const char* k, const __vgTy* t, __vgVH v) {
  o.key(k);
  double d = 0;
  if (t && t->kind == 1 && t->info == 32) { float f; uint32_t u = static_cast<uint32_t>(v); memcpy(&f, &u, 4); d = f; }
  else if (t && t->kind == 1 && t->info == 64) memcpy(&d, reinterpret_cast<const void*>(v), 8);
  else { o.raw("null"); return; }
  char tmp[40];
  if (std::isfinite(d)) snprintf(tmp, sizeof tmp, "%.17g", d);
  else snprintf(tmp, sizeof tmp, "\"%s\"", std::isnan(d) ? "nan" : d > 0 ? "inf" : "-inf");
  o.raw(tmp);
}
VGNS inline void putUInt(Buf& o, const char* k, unsigned long long x) {
  char tmp[32];
  snprintf(tmp, sizeof tmp, "%llu", x);
  o.key(k);
  o.raw(tmp);
}
VGNS inline void putStr(Buf& o, const char* k, const char* s) { o.key(k); o.str(s, 240); }
VGNS inline void putType(Buf& o, const char* k, const __vgTy* t) { putStr(o, k, t ? t->name : "?"); }

// Recoverable errors: each source location once, at most 64 locations (later ones are not reported).
VGNS inline bool firstAt(const __vgLoc* l) {
  static const __vgLoc* seen[64];
  static int count = 0;
  for (int i = 0; i < count; i++) if (seen[i] == l) return false;
  if (count >= 64) return false;
  seen[count++] = l;
  return true;
}

// values: the members of "v" (already JSON), or "" for none; msg: a free-text message or nullptr
VGNS inline void report(const char* kind, bool fatal, const __vgLoc* l, const char* values, const char* msg) {
  std::fflush(stdout);  // like vg.h's step(): what the program printed before the error is stamped before this record
  Buf r;
  r.raw("{\"err\":\"");
  r.raw(kind);
  r.raw(fatal ? "\",\"fatal\":1" : "\",\"fatal\":0");
  if (l && l->file) { r.key("file"); r.str(l->file, 300); }
  char tmp[48];
  snprintf(tmp, sizeof tmp, ",\"line\":%u,\"col\":%u", l ? static_cast<unsigned>(l->line) : 0u, l ? static_cast<unsigned>(l->col) : 0u);
  r.raw(tmp);
  if (values && *values) { r.raw(",\"v\":{"); r.raw(values); r.raw("}"); }
  if (msg) { r.key("msg"); r.str(msg, 600); }
  r.raw("}\n");
  __wasi_ciovec_t io{reinterpret_cast<const uint8_t*>(r.b), r.n};
  __wasi_size_t w = 0;
  (void)__wasi_fd_write(3, &io, 1, &w);
}
[[noreturn]] VGNS inline void die(const char* kind, const __vgLoc* l, const char* values, const char* msg = nullptr) {
  report(kind, true, l, values, msg);
  __wasi_proc_exit(134);
}
VGNS inline void soft(const char* kind, const __vgLoc* l, const char* values) {
  if (firstAt(l)) report(kind, false, l, values, nullptr);
}
}  // namespace __vgerr

// Handler pairs. BODY fills `v` (a Buf holding the members of "v") and sets `kind`. The plain entry is called for checks
// compiled as recoverable (CHECK_FLAGS' -fsanitize-recover list): RECOVER decides whether that kind goes on; the _abort
// entry is called for the others and always ends the program.
#define VG_PAIR(NAME, PARAMS, LOC, RECOVER, BODY)                                       \
  extern "C" VGNS void __ubsan_handle_##NAME PARAMS {                                  \
    const char* kind = ""; __vgerr::Buf v; v.raw("{"); BODY                            \
    if (RECOVER) __vgerr::soft(kind, LOC, v.b + 1); else __vgerr::die(kind, LOC, v.b + 1); \
  }                                                                                    \
  extern "C" [[noreturn]] VGNS void __ubsan_handle_##NAME##_abort PARAMS {             \
    const char* kind = ""; __vgerr::Buf v; v.raw("{"); BODY                            \
    __vgerr::die(kind, LOC, v.b + 1);                                                  \
  }

#define VG_OVF(NAME, OP)                                                                                   \
  VG_PAIR(NAME, (__vgOvf* d, __vgVH a, __vgVH b), &d->loc, true, {                                         \
    kind = "signed-overflow"; __vgerr::putStr(v, "op", OP); __vgerr::putInt(v, "lhs", d->ty, a);           \
    __vgerr::putInt(v, "rhs", d->ty, b); __vgerr::putType(v, "type", d->ty); })
VG_OVF(add_overflow, "+")
VG_OVF(sub_overflow, "-")
VG_OVF(mul_overflow, "*")
VG_PAIR(negate_overflow, (__vgOvf* d, __vgVH a), &d->loc, true, {
  kind = "signed-overflow"; __vgerr::putStr(v, "op", "neg"); __vgerr::putInt(v, "lhs", d->ty, a); __vgerr::putType(v, "type", d->ty); })
// x / 0 and INT_MIN / -1 trap natively (SIGFPE) and in wasm: always fatal, even through the recoverable entry
VG_PAIR(divrem_overflow, (__vgOvf* d, __vgVH a, __vgVH b), &d->loc, false, {
  const bool zero = d->ty && d->ty->kind == 0 ? (d->ty->info >> 1) <= 5 ? static_cast<uint32_t>(b) == 0
                                                 : *reinterpret_cast<const uint64_t*>(b) == 0 : true;
  kind = zero ? "div-by-zero" : "div-overflow";
  __vgerr::putInt(v, "lhs", d->ty, a); __vgerr::putInt(v, "rhs", d->ty, b); __vgerr::putType(v, "type", d->ty); })
VG_PAIR(shift_out_of_bounds, (__vgShift* d, __vgVH a, __vgVH b), &d->loc, true, {
  kind = "shift"; __vgerr::putInt(v, "lhs", d->lhsTy, a); __vgerr::putInt(v, "rhs", d->rhsTy, b);
  __vgerr::putType(v, "type", d->lhsTy);
  __vgerr::putUInt(v, "bits", d->lhsTy && d->lhsTy->kind == 0 ? 1u << (d->lhsTy->info >> 1) : 0); })
VG_PAIR(out_of_bounds, (__vgOob* d, __vgVH i), &d->loc, true, {
  kind = "array-bounds"; __vgerr::putInt(v, "index", d->idxTy, i); __vgerr::putType(v, "array", d->arrTy); })
VG_PAIR(type_mismatch_v1, (__vgMismatch* d, __vgVH p), &d->loc, false, {
  kind = p == 0 ? "null-deref" : (p & ((1u << d->logAlign) - 1)) ? "misaligned" : "object-size";
  __vgerr::putType(v, "type", d->ty); __vgerr::putUInt(v, "ptr", p); __vgerr::putUInt(v, "tck", d->tck);
  __vgerr::putUInt(v, "align", 1u << d->logAlign); })
VG_PAIR(vla_bound_not_positive, (__vgInvalid* d, __vgVH b), &d->loc, false, {
  kind = "vla-bound"; __vgerr::putInt(v, "bound", d->ty, b); __vgerr::putType(v, "type", d->ty); })
VG_PAIR(float_cast_overflow, (__vgFloatCast* d, __vgVH x), &d->loc, true, {
  kind = "float-cast-overflow"; __vgerr::putFloat(v, "value", d->from, x);
  __vgerr::putType(v, "from", d->from); __vgerr::putType(v, "to", d->to); })
VG_PAIR(load_invalid_value, (__vgInvalid* d, __vgVH x), &d->loc, false, {
  kind = "invalid-value"; (void)x; __vgerr::putType(v, "type", d->ty); })
VG_PAIR(invalid_builtin, (__vgBuiltin* d), &d->loc, false, { kind = "invalid-builtin"; __vgerr::putUInt(v, "builtin", d->kind); })
VG_PAIR(nonnull_arg, (__vgNonnullArg* d), &d->loc, false, { kind = "nonnull-arg"; __vgerr::putUInt(v, "arg", static_cast<unsigned>(d->arg)); })
VG_PAIR(nonnull_return_v1, (__vgOnlyLoc* d, __vgLoc* l), l, false, { kind = "nonnull-return"; (void)d; })
VG_PAIR(pointer_overflow, (__vgOnlyLoc* d, __vgVH base, __vgVH res), &d->loc, true, {
  kind = "pointer-overflow"; __vgerr::putUInt(v, "base", base); __vgerr::putUInt(v, "result", res); })
VG_PAIR(alignment_assumption, (__vgOnlyLoc* d, __vgVH p, __vgVH a, __vgVH o), &d->loc, false, {
  kind = "alignment-assumption"; (void)p; (void)a; (void)o; })
extern "C" [[noreturn]] VGNS void __ubsan_handle_builtin_unreachable(__vgOnlyLoc* d) { __vgerr::die("unreachable", &d->loc, ""); }
extern "C" [[noreturn]] VGNS void __ubsan_handle_missing_return(__vgOnlyLoc* d) { __vgerr::die("missing-return", &d->loc, ""); }

// wasi-libc (musl) assert() lands here; a definition in the program replaces libc's copy.
extern "C" VGNS void __assert_fail(const char* expr, const char* file, int line, const char* func) {
  __vgerr::Buf v;
  v.raw("{");
  __vgerr::putStr(v, "expr", expr);
  __vgerr::putStr(v, "func", func);
  __vgLoc l{file, static_cast<uint32_t>(line), 0};
  __vgerr::die("assert", &l, v.b + 1);
}

// libc++ hardening (EXTENSIVE): the replacement include/c++/v1/__assertion_handler routes every failed check here with
// libc++'s own message ("...vector:1436: assertion __n < size() failed: vector[] index out of bounds\n").
extern "C" [[noreturn]] VGNS void __vg_libcxx_assert(const char* message) { __vgerr::die("libcxx", nullptr, "", message); }

// -fno-exceptions "throws" (at(), substr(), stoi, ...) and libc++'s DEBUG mode end here with a printf-style message.
_LIBCPP_BEGIN_NAMESPACE_STD
VGNS void __libcpp_verbose_abort(const char* fmt, ...) {
  char msg[600];
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(msg, sizeof msg, fmt, ap);
  va_end(ap);
  __vgerr::die("libcxx", nullptr, "", msg);
}
_LIBCPP_END_NAMESPACE_STD
