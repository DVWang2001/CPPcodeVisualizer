#!/usr/bin/env bash
# Throwaway accounts on the previews (5002 = P1 build, 5003 = the live image, run by preview_old.sh). The password is
# random, generated here and never printed; the session cookies stay in jar-<port>.txt next to this script.
set -u
DIR="$HOME/iris-a-tests/p1"
for port in "$@"; do
  jar="$DIR/jar-$port.txt"; rm -f "$jar"
  csrf=$(curl -s -c "$jar" -b "$jar" "http://127.0.0.1:$port/register" | grep -o 'name="csrf_token" value="[^"]*"' | head -n 1 | sed 's/.*value="//; s/"$//')
  if [ -z "$csrf" ]; then echo "$port: no csrf token"; continue; fi
  pw=$(head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 20)
  user="warm$(date +%s | tail -c 6)$port"
  res=$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' -c "$jar" -b "$jar" \
    --data-urlencode "csrf_token=$csrf" --data-urlencode "username=$user" --data-urlencode "display_name=warmup-test" \
    --data-urlencode "password=$pw" "http://127.0.0.1:$port/register")
  unset pw
  echo "$port: $user -> $res; session cookie lines: $(grep -c 'session' "$jar")"
done
