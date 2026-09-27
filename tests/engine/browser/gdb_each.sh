#!/bin/bash
# 每份教案前重啟本機測試容器（清掉這個帳號的 GDB session 狀態），再開隔離 Chrome 單獨跑 GDB 引擎的手動模式。
# 用法：bash gdb_each.sh "2 7 8 9 ..."   結果 tag = mgdbC，每份 only=1。
F='C:/碩士/研究/papper/CPPcodeVisualizer/tests/engine/browser/autorun_results.jsonl'
PROF="$(cygpath -w "$TEMP")\vg-chrome-profile-iso"
CHROME='C:\Program Files\Google\Chrome\Application\chrome.exe'
for i in $1; do
  docker restart cppcodevisualizer-gdbgui-1 >/dev/null 2>&1; sleep 14
  URL="http://127.0.0.1:9195/edit?engine=gdb&auto=1&mode=manual&steps=30&batch=1&only=1&idx=$i&tag=${TAGX:-mgdbC}&seed=12345&iso=1"
  powershell -NoProfile -Command "Start-Process -FilePath '$CHROME' -ArgumentList @('--user-data-dir=$PROF','--no-first-run','--no-default-browser-check','--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows','--autoplay-policy=no-user-gesture-required','--mute-audio','--window-size=1400,900','--new-window','$URL')"
  for t in $(seq 1 60); do sleep 5; if grep -q "\"tag\":\"${TAGX:-mgdbC}\",\"idx\":$i,\"ev\":\"end\"" "$F" 2>/dev/null; then break; fi; done
  powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { \$_.CommandLine -match 'vg-chrome-profile-iso' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }"
  sleep 3
done
echo EACH_DONE >> "$F.each"
