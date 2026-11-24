#!/usr/bin/env bash
# Refill the P1 preview after a rebuild: check the served bundle keeps __bug, register a throwaway account, create the
# demo lessons in a fixed order (ids 1-8).
set -u
DIR="$HOME/iris-a-tests/p1"
cd "$DIR" || exit 3
m=$(curl -s http://127.0.0.1:5002/login | grep -o '/static/js/main.js?_=[^"]*' | head -n 1)
echo "bundle $m: keeps __bug in run_initial_commands: $(curl -s "http://127.0.0.1:5002$m" | grep -c '"__layout"!==e&&"__bug"!==e')"
bash preview_accounts.sh 5002
bash preview_lesson_file.sh quick_sort.json "vector經典_快速排序" 5002
bash preview_lesson_file.sh err_array_oob.json "錯誤_陣列越界" 5002
bash preview_lesson_file.sh err_null_deref.json "錯誤_空指標（現在的說明）" 5002
bash preview_lesson_file.sh variants/ovf_current.json "錯誤_整數溢位（現在的說明）" 5002
bash preview_lesson_file.sh variants/ovf_A.json "錯誤_整數溢位（方案A）" 5002
bash preview_lesson_file.sh variants/ovf_B.json "錯誤_整數溢位（方案B）" 5002
bash preview_lesson_file.sh variants/nul_A.json "錯誤_空指標（方案A）" 5002
bash preview_lesson_file.sh variants/nul_B.json "錯誤_空指標（方案B）" 5002
