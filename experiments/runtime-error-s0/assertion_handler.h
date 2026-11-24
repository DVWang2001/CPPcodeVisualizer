// IRIS S0: replacement for libc++'s vendor file include/c++/v1/__assertion_handler (libc++ 19.1.5).
// The stock file makes FAST/EXTENSIVE checks a silent __builtin_verbose_trap (the message only exists in debug
// info); this one hands the message to __vg_libcxx_assert (defined in vgerr.h) so the run can report it.
// DEBUG mode keeps libc++'s own route (_LIBCPP_VERBOSE_ABORT), exactly like the stock file.
#ifndef _LIBCPP___ASSERTION_HANDLER
#define _LIBCPP___ASSERTION_HANDLER

#include <__config>
#include <__verbose_abort>

#if !defined(_LIBCPP_HAS_NO_PRAGMA_SYSTEM_HEADER)
#  pragma GCC system_header
#endif

extern "C" {
[[__noreturn__]] void __vg_libcxx_assert(const char* __message);
}

#if _LIBCPP_HARDENING_MODE == _LIBCPP_HARDENING_MODE_DEBUG
#  define _LIBCPP_ASSERTION_HANDLER(message) _LIBCPP_VERBOSE_ABORT("%s", message)
#else
#  define _LIBCPP_ASSERTION_HANDLER(message) ::__vg_libcxx_assert(message)
#endif

#endif // _LIBCPP___ASSERTION_HANDLER
