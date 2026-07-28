#!/bin/bash
# sandbox/wrapper.sh — GDB exec-wrapper（只做資源限制）
#
# GDB 執行 inferior 前會先呼叫這個 wrapper（透過 "set exec-wrapper" 命令）。
# wrapper 設定資源限制後，用 exec 取代自己，讓 GDB 能正常 ptrace inferior。
#
# 這個 wrapper **不做**降權，也不做 namespace 隔離。那兩件事發生在更外層：
# GDB 行程本身就已經以該 session 的臨時 OS 帳號、在 unshare --user --net 內
# 啟動（見 sandbox/jail_manager.py）。在這裡再換一次 uid 只會讓 GDB 失去
# ptrace 權限——跨 uid / 跨 user namespace 的 ptrace 就算給 CAP_SYS_PTRACE
# 也不會動，這是實測結果。
#
# 限制說明（RLIMIT 會被 exec 繼承，所以套用在被除錯的程式上）：
#   -f 1024   最多寫入 512 KB（單個檔案）
#   -c 0      禁止產生 core dump
#   -u 64     最多 64 個子程序（防止 fork bomb）。RLIMIT_NPROC 是按 real uid
#             計算的，現在每個 session 有自己的 uid，這條限制才真的是 per-session。
#   -t 30     最多 30 秒 CPU 時間（防止無窮迴圈佔用 CPU）
#   -v 524288 最多使用 512 MB 虛擬記憶體

ulimit -f 1024    2>/dev/null  # 512 KB 最大檔案寫入
ulimit -c 0       2>/dev/null  # 禁止 core dump
ulimit -u 64      2>/dev/null  # 最多 64 個子程序
ulimit -t 30      2>/dev/null  # 30 秒 CPU 時間上限
ulimit -v 524288  2>/dev/null  # 512 MB 虛擬記憶體上限

exec "$@"
