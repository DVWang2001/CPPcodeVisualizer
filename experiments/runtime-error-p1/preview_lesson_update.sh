#!/usr/bin/env bash
# Replace an existing lesson's title and bundle as its owner (the throwaway account in jar-PORT.txt):
#   preview_lesson_update.sh ID FILE TITLE PORT
set -u
DIR="$HOME/iris-a-tests/p1"
id="$1"; file="$2"; title="$3"; port="$4"
python3 -c 'import json,sys; print(json.dumps({"title": sys.argv[2], "bundle": json.load(open(sys.argv[1], encoding="utf-8"))}, ensure_ascii=False))' "$file" "$title" > "$DIR/lesson-body.json" || exit 3
tok=$(curl -s -b "$DIR/jar-$port.txt" "http://127.0.0.1:$port/" | grep -o 'data-csrf="[^"]*"' | head -n 1 | sed 's/data-csrf="//; s/"$//')
[ -n "$tok" ] || { echo "$port: no csrf token"; exit 4; }
echo "$port lesson $id: $(curl -s -X PUT -w ' HTTP %{http_code}' -b "$DIR/jar-$port.txt" -H 'Content-Type: application/json' -H "X-CSRFToken: $tok" --data-binary @"$DIR/lesson-body.json" "http://127.0.0.1:$port/api/lessons/$id" | tr -d '\n')"
rm -f "$DIR/lesson-body.json"
