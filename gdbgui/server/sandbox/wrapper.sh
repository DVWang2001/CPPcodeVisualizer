#!/bin/bash
# sandbox/wrapper.sh — GDB exec-wrapper
#
# GDB 執行 inferior 前會先呼叫這個 wrapper（透過 "set exec-wrapper" 命令）。
# wrapper 設定資源限制後，用 exec 取代自己，讓 GDB 能正常 ptrace inferior。
#
# 限制說明：
#   -f 1024   最多寫入 512 KB（單個檔案）
#   -c 0      禁止產生 core dump
#   -u 64     最多 64 個子程序（防止 fork bomb）
#   -t 30     最多 30 秒 CPU 時間（防止無窮迴圈佔用 CPU）
#   -v 524288 最多使用 512 MB 虛擬記憶體

ulimit -f 1024    2>/dev/null  # 512 KB 最大檔案寫入
ulimit -c 0       2>/dev/null  # 禁止 core dump
ulimit -u 64      2>/dev/null  # 最多 64 個子程序
ulimit -t 30      2>/dev/null  # 30 秒 CPU 時間上限
ulimit -v 524288  2>/dev/null  # 512 MB 虛擬記憶體上限

exec "$@"