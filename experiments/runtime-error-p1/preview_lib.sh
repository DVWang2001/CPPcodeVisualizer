#!/usr/bin/env bash
# Lesson links in each preview's library (as the throwaway account), to pick the same lesson on both.
set -u
DIR="$HOME/iris-a-tests/p1"
for port in "$@"; do
  curl -s -b "$DIR/jar-$port.txt" "http://127.0.0.1:$port/" > /tmp/lib-$port.html
  echo "$port: library $(wc -c < /tmp/lib-$port.html) bytes, lesson links $(grep -o 'edit?lesson=[0-9]*' /tmp/lib-$port.html | sort -u | wc -l)"
  grep -o 'edit?lesson=[0-9]*"[^<]*<[^<]*' /tmp/lib-$port.html | head -3
  rm -f /tmp/lib-$port.html
done
