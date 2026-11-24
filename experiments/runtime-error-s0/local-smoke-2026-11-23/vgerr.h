// Spike only: UBSan handler ABI (compiler-rt ubsan_handlers.h) implemented inside the program,
// plus a libc++ verbose-abort override. Each handler prints ONE JSON line to stderr and exits 134.
#pragma once
#include <wasi/api.h>
#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <__verbose_abort>

extern "C" {
struct __vgLoc { const char* file; uint32_t line; uint32_t col; };
struct __vgTy { uint16_t kind; uint16_t info; char name[1]; };
typedef uintptr_t __vgVH;
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

namespace __vgerr {
#define VGNS __attribute__((no_sanitize("undefined")))
VGNS inline void out(const char* s) {
  __wasi_ciovec_t io{reinterpret_cast<const uint8_t*>(s), strlen(s)};
  __wasi_size_t n = 0;
  (void)__wasi_fd_write(2, &io, 1, &n);
}
// integer TypeDescriptor: info = (log2(bit width) << 1) | is_signed
VGNS inline long long ival(const __vgTy* t, __vgVH v) {
  if (!t || t->kind != 0) return 0;
  unsigned bits = 1u << (t->info >> 1);
  bool sgn = t->info & 1;
  if (bits <= 32) {
    uint32_t u = (uint32_t)v;
    if (!sgn) return (long long)u;
    if (bits == 32) return (int32_t)u;
    if (bits == 16) return (int16_t)u;
    return (int8_t)u;
  }
  long long x = 0;
  memcpy(&x, reinterpret_cast<const void*>(v), 8);
  return x;
}
VGNS inline double fval(const __vgTy* t, __vgVH v) {
  unsigned bits = t ? t->info : 0;  // float TypeDescriptor: info = bit width
  if (bits == 32) { float f; uint32_t u = (uint32_t)v; memcpy(&f, &u, 4); return f; }
  double d = 0; memcpy(&d, reinterpret_cast<const void*>(v), 8); return d;
}
[[noreturn]] VGNS inline void die(const char* kind, const __vgLoc* l, const char* extra) {
  char buf[640];
  snprintf(buf, sizeof buf, "{\"vgerr\":\"%s\",\"line\":%u,\"col\":%u%s%s}\n", kind,
           l ? (unsigned)l->line : 0u, l ? (unsigned)l->col : 0u, extra && *extra ? "," : "", extra ? extra : "");
  out(buf);
  __wasi_proc_exit(134);
}
VGNS inline void two(char* b, size_t n, const __vgTy* t, __vgVH a, __vgVH c) {
  snprintf(b, n, "\"type\":\"%s\",\"lhs\":%lld,\"rhs\":%lld", t ? t->name : "?", ival(t, a), ival(t, c));
}
}  // namespace __vgerr

#define VG_PAIR(NAME, PARAMS, BODY) \
  extern "C" VGNS void __ubsan_handle_##NAME PARAMS BODY \
  extern "C" VGNS void __ubsan_handle_##NAME##_abort PARAMS BODY

VG_PAIR(add_overflow, (__vgOvf* d, __vgVH a, __vgVH b), { char e[256]; __vgerr::two(e, sizeof e, d->ty, a, b); __vgerr::die("signed-overflow:+", &d->loc, e); })
VG_PAIR(sub_overflow, (__vgOvf* d, __vgVH a, __vgVH b), { char e[256]; __vgerr::two(e, sizeof e, d->ty, a, b); __vgerr::die("signed-overflow:-", &d->loc, e); })
VG_PAIR(mul_overflow, (__vgOvf* d, __vgVH a, __vgVH b), { char e[256]; __vgerr::two(e, sizeof e, d->ty, a, b); __vgerr::die("signed-overflow:*", &d->loc, e); })
VG_PAIR(negate_overflow, (__vgOvf* d, __vgVH a), { char e[160]; snprintf(e, sizeof e, "\"old\":%lld", __vgerr::ival(d->ty, a)); __vgerr::die("signed-overflow:neg", &d->loc, e); })
VG_PAIR(divrem_overflow, (__vgOvf* d, __vgVH a, __vgVH b), {
  char e[256]; __vgerr::two(e, sizeof e, d->ty, a, b);
  __vgerr::die(__vgerr::ival(d->ty, b) == 0 ? "div-by-zero" : "div-overflow", &d->loc, e); })
VG_PAIR(shift_out_of_bounds, (__vgShift* d, __vgVH a, __vgVH b), {
  char e[256]; snprintf(e, sizeof e, "\"lhs\":%lld,\"rhs\":%lld", __vgerr::ival(d->lhsTy, a), __vgerr::ival(d->rhsTy, b));
  __vgerr::die("shift", &d->loc, e); })
VG_PAIR(out_of_bounds, (__vgOob* d, __vgVH i), {
  char e[256]; snprintf(e, sizeof e, "\"array\":\"%s\",\"index\":%lld", d->arrTy->name, __vgerr::ival(d->idxTy, i));
  __vgerr::die("array-bounds", &d->loc, e); })
VG_PAIR(type_mismatch_v1, (__vgMismatch* d, __vgVH p), {
  char e[256]; snprintf(e, sizeof e, "\"type\":\"%s\",\"ptr\":%lu,\"tck\":%u", d->ty->name, (unsigned long)p, (unsigned)d->tck);
  __vgerr::die(p == 0 ? "null-deref" : ((p & ((1u << d->logAlign) - 1)) ? "misaligned" : "object-size"), &d->loc, e); })
VG_PAIR(vla_bound_not_positive, (__vgInvalid* d, __vgVH b), { char e[96]; snprintf(e, sizeof e, "\"bound\":%lld", __vgerr::ival(d->ty, b)); __vgerr::die("vla-bound", &d->loc, e); })
VG_PAIR(float_cast_overflow, (__vgFloatCast* d, __vgVH v), {
  char e[256]; snprintf(e, sizeof e, "\"from\":\"%s\",\"to\":\"%s\",\"value\":%.17g", d->from->name, d->to->name, __vgerr::fval(d->from, v));
  __vgerr::die("float-cast-overflow", &d->loc, e); })
VG_PAIR(load_invalid_value, (__vgInvalid* d, __vgVH v), { char e[160]; snprintf(e, sizeof e, "\"type\":\"%s\"", d->ty->name); (void)v; __vgerr::die("invalid-value", &d->loc, e); })
VG_PAIR(invalid_builtin, (__vgBuiltin* d), { __vgerr::die("invalid-builtin", &d->loc, ""); })
VG_PAIR(nonnull_arg, (__vgNonnullArg* d), { char e[64]; snprintf(e, sizeof e, "\"arg\":%d", d->arg); __vgerr::die("nonnull-arg", &d->loc, e); })
VG_PAIR(nonnull_return_v1, (__vgOnlyLoc* d, __vgLoc* l), { (void)d; __vgerr::die("nonnull-return", l, ""); })
VG_PAIR(pointer_overflow, (__vgOnlyLoc* d, __vgVH base, __vgVH res), {
  char e[128]; snprintf(e, sizeof e, "\"base\":%lu,\"result\":%lu", (unsigned long)base, (unsigned long)res); __vgerr::die("pointer-overflow", &d->loc, e); })
VG_PAIR(alignment_assumption, (__vgOnlyLoc* d, __vgVH p, __vgVH a, __vgVH o), { (void)p; (void)a; (void)o; __vgerr::die("alignment-assumption", &d->loc, ""); })
// wasi-libc (musl) assert() lands here; defining it in the program replaces libc's copy.
extern "C" VGNS void __assert_fail(const char* expr, const char* file, int line, const char* func) {
  char e[400]; snprintf(e, sizeof e, "\"expr\":\"%s\",\"func\":\"%s\"", expr, func); (void)file;
  __vgLoc l{file, (uint32_t)line, 0};
  __vgerr::die("assert", &l, e);
}
extern "C" VGNS void __ubsan_handle_builtin_unreachable(__vgOnlyLoc* d) { __vgerr::die("unreachable", &d->loc, ""); }
extern "C" VGNS void __ubsan_handle_missing_return(__vgOnlyLoc* d) { __vgerr::die("missing-return", &d->loc, ""); }

// libc++ hardening (debug mode) and -fno-exceptions "throws" both end here with a printf-style message.
_LIBCPP_BEGIN_NAMESPACE_STD
VGNS void __libcpp_verbose_abort(const char* fmt, ...) {
  char msg[400];
  va_list ap; va_start(ap, fmt); vsnprintf(msg, sizeof msg, fmt, ap); va_end(ap);
  char esc[480]; size_t k = 0;
  for (const char* c = msg; *c && k + 2 < sizeof esc; ++c) {
    if (*c == '"' || *c == '\\') { esc[k++] = '\\'; esc[k++] = *c; }
    else if (*c == '\n') { esc[k++] = ' '; }
    else esc[k++] = *c;
  }
  esc[k] = 0;
  char e[560]; snprintf(e, sizeof e, "\"msg\":\"%s\"", esc);
  __vgerr::die("libcxx", nullptr, e);
}
_LIBCPP_END_NAMESPACE_STD
