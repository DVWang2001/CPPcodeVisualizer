#!/usr/bin/env bash
# The current live image as a second preview on 127.0.0.1:5003 (before/after comparisons), own volume.
set -u
docker rm -f iris-preview-old > /dev/null 2>&1; docker volume rm iris-preview-old-data > /dev/null 2>&1
docker run -d --name iris-preview-old --init --security-opt no-new-privileges:true --cpus 1 -m 600m \
  -p 127.0.0.1:5003:5000 -v iris-preview-old-data:/var/lib/gdbgui \
  -e PYTHONUNBUFFERED=1 -e PYTHONDONTWRITEBYTECODE=1 -e GDBGUI_REQUIRE_ISOLATION=1 \
  -e MOBILE_JOIN_BASE_URL=http://120.125.77.193:5003 "$(docker inspect -f '{{.Config.Image}}' cppcodevisualizer-gdbgui-1)" > /dev/null || exit 9
for i in $(seq 1 60); do [ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:5003/login)" = 200 ] && break; sleep 1; done
echo "old preview image $(docker inspect -f '{{.Config.Image}} {{.Image}}' iris-preview-old | cut -c1-60) /login: $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:5003/login)"
