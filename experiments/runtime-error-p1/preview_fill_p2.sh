#!/usr/bin/env bash
# Fill the P2 preview after a rebuild: check the served bundle carries the P2 runtime-error panel, register a throwaway
# account, create the P2 demo lessons in the order of p2lessons/order.txt (ids 1-9 on a fresh volume).
set -u
DIR="$HOME/iris-a-tests/p1"
cd "$DIR" || exit 3
m=/static/js/main.js  # /login does not load the app bundle, so read it from its fixed path (the ?_= suffix only busts caches)
curl -s "http://127.0.0.1:5002$m" > /tmp/p2main.js
echo "bundle $m ($(wc -c < /tmp/p2main.js) bytes): rt-view $(grep -o 'rt-view' /tmp/p2main.js | wc -l), runtime_errors $(grep -o 'runtime_errors' /tmp/p2main.js | wc -l), monaco-runtime-error-line $(grep -o 'monaco-runtime-error-line' /tmp/p2main.js | wc -l)"
rm -f /tmp/p2main.js
bash preview_accounts.sh 5002
while IFS='|' read -r file title; do
  [ -n "$file" ] && bash preview_lesson_file.sh "p2lessons/$file" "$title" 5002
done < p2lessons/order.txt
