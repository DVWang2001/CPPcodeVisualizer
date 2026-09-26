// libstdc++ 的 debug 模式巨集：pb_ds 只用到斷言，全部關閉。
#pragma once
#include <bits/c++config.h>
#define _GLIBCXX_DEBUG_VERIFY_AT(_Cond, _Msg, _Loc) ((void)0)
