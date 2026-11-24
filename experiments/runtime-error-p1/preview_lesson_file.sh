#!/usr/bin/env bash
# Create one lesson in each given preview as the throwaway account: preview_lesson_file.sh FILE TITLE PORT...
set -u
DIR="$HOME/iris-a-tests/p1"
file="$1"; title="$2"; shift 2
python3 -c 'import json,sys; print(json.dumps({"title": sys.argv[2], "bundle": json.load(open(sys.argv[1], encoding="utf-8"))}, ensure_ascii=False))' "$file" "$title" > "$DIR/lesson-body.json" || exit 3
for port in "$@"; do
  tok=$(curl -s -b "$DIR/jar-$port.txt" "http://127.0.0.1:$port/" | grep -o 'data-csrf="[^"]*"' | head -n 1 | sed 's/data-csrf="//; s/"$//')
  [ -n "$tok" ] || { echo "$port: no csrf token"; continue; }
  echo "$port $title: $(curl -s -w ' HTTP %{http_code}' -b "$DIR/jar-$port.txt" -H 'Content-Type: application/json' -H "X-CSRFToken: $tok" --data-binary @"$DIR/lesson-body.json" "http://127.0.0.1:$port/api/lessons" | tr -d '\n')"
done
rm -f "$DIR/lesson-body.json"
