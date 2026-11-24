#!/usr/bin/env bash
# Create the same lesson (examples/lessons/vector經典_快速排序/quick_sort.json, copied here as quick_sort.json) in each
# preview as the throwaway account, and print the new lesson id.
set -u
DIR="$HOME/iris-a-tests/p1"
python3 -c 'import json,sys; print(json.dumps({"title": "vector經典_快速排序", "bundle": json.load(open(sys.argv[1], encoding="utf-8"))}, ensure_ascii=False))' "$DIR/quick_sort.json" > "$DIR/lesson-body.json" || exit 3
for port in "$@"; do
  tok=$(curl -s -b "$DIR/jar-$port.txt" "http://127.0.0.1:$port/" | grep -o 'data-csrf="[^"]*"' | head -n 1 | sed 's/data-csrf="//; s/"$//')
  [ -n "$tok" ] || { echo "$port: no csrf token"; continue; }
  res=$(curl -s -w ' HTTP %{http_code}' -b "$DIR/jar-$port.txt" -H 'Content-Type: application/json' -H "X-CSRFToken: $tok" \
    --data-binary @"$DIR/lesson-body.json" "http://127.0.0.1:$port/api/lessons")
  echo "$port: $res"
done
rm -f "$DIR/lesson-body.json"
