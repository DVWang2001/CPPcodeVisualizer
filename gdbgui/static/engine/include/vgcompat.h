// vgdb compatibility layer: force-included (-include vgcompat.h) into EVERY compile, instrumented or not.
// It papers over libstdc++/MinGW-isms that the course examples rely on but clang+libc++ (wasm32-wasi)
// does not provide (spec 2026-09-26-engine-boundary.md, finding F8):
//   * std::__gcd  — libstdc++ internal used by 6 examples (CC-2602B/2603B/2604B/2605B/2606B/2608B).
//                   libc++ only has an unsigned-only template in <numeric>; these non-template
//                   overloads are preferred for exact matches and coexist with it.
//   * __int64     — MSVC/MinGW spelling used by CC-2602B.
// Keep this header tiny and dependency-free: it is part of the PCH key (headers.tar sha256).
#pragma once
#ifndef VGDB_COMPAT_H
#define VGDB_COMPAT_H

typedef long long __int64;

namespace std {
#define VGDB_GCD_(T) \
  inline constexpr T __gcd(T __m, T __n) { while (__n != 0) { T __t = __m % __n; __m = __n; __n = __t; } return __m; }
VGDB_GCD_(int) VGDB_GCD_(long) VGDB_GCD_(long long) VGDB_GCD_(short) VGDB_GCD_(signed char)
VGDB_GCD_(unsigned int) VGDB_GCD_(unsigned long) VGDB_GCD_(unsigned long long) VGDB_GCD_(unsigned short)
VGDB_GCD_(unsigned char)
#undef VGDB_GCD_
}  // namespace std

#endif
