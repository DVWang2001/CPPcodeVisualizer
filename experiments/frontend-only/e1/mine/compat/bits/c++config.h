// libstdc++ 相容層（給 pb_ds 用）：定義 pb_ds 會用到的 _GLIBCXX_* 巨集。
#pragma once
#include <cstddef>
#define _GLIBCXX_BEGIN_NAMESPACE_VERSION
#define _GLIBCXX_END_NAMESPACE_VERSION
#define _GLIBCXX_BEGIN_NAMESPACE_CONTAINER
#define _GLIBCXX_END_NAMESPACE_CONTAINER
#define _GLIBCXX_BEGIN_NAMESPACE_ALGO
#define _GLIBCXX_END_NAMESPACE_ALGO
#define _GLIBCXX_VISIBILITY(V)
#define _GLIBCXX_NOEXCEPT noexcept
#define _GLIBCXX_NOEXCEPT_IF(C) noexcept(C)
#define _GLIBCXX_USE_NOEXCEPT noexcept
#define _GLIBCXX_THROW(X)
#define _GLIBCXX_THROW_OR_ABORT(X) __builtin_abort()
#define _GLIBCXX_CONSTEXPR constexpr
#define _GLIBCXX14_CONSTEXPR constexpr
#define _GLIBCXX17_CONSTEXPR constexpr
#define _GLIBCXX20_CONSTEXPR constexpr
#define _GLIBCXX_NODISCARD [[nodiscard]]
#define _GLIBCXX_HAVE_ATTRIBUTE_VISIBILITY 0
#define _GLIBCXX_PURE
#define _GLIBCXX_CONST
#define _GLIBCXX_DEPRECATED
#define _GLIBCXX_ASSERTIONS_DISABLED
#define __glibcxx_assert(C) ((void)0)
#define _GLIBCXX_DEBUG_ASSERT(C) ((void)0)
#define _GLIBCXX_DEBUG_PEDASSERT(C) ((void)0)
#define _GLIBCXX_DEBUG_ONLY(X)
#define _GLIBCXX_STD_C std
#define _GLIBCXX_SYSHDR
#define _GLIBCXX_DEBUG_VERIFY(_Cond, _Msg) ((void)0)
// -fno-exceptions 下 libstdc++ 自己的定義（WASI 沒有 C++ 例外）
#define __N(msgid) (msgid)
#define __try if (true)
#define __catch(X) if (false)
#define __throw_exception_again
#undef _GLIBCXX_THROW_OR_ABORT
#define _GLIBCXX_THROW_OR_ABORT(_EXC) (__builtin_abort())
