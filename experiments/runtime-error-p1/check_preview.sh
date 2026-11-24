#!/usr/bin/env bash
# Is the preview on 5002 serving the P1 files? Compare served static files with the staged copies, and look inside the
# image for the built bundle and the header archive.
set -u
F="$HOME/iris-a-tests/p1/files"
for f in gdbgui/static/engine/prewarm.js gdbgui/static/engine/index.js gdbgui/static/engine/pipeline.worker.js gdbgui/static/engine/trace.js; do
  url="http://127.0.0.1:5002/${f#gdbgui/}"
  code=$(curl -s -o /tmp/p1chk.bin -w '%{http_code} %{content_type}' "$url")
  if cmp -s /tmp/p1chk.bin "$F/$f"; then echo "same   $code  $f"; else echo "DIFFER $code  $f"; fi
done
rm -f /tmp/p1chk.bin
echo "manifest headers.tar: $(curl -s http://127.0.0.1:5002/static/engine/assets/manifest.json | grep -o '"headers.tar"[^}]*' | grep -o '"size":[0-9]*')"
docker run --rm --network none --entrypoint sh iris-preview:p1 -c '
  cd /app/gdbgui/static
  echo "bundle warm-up strings: $(grep -o "vgdb-warmup" js/*.js | wc -l)  console tag: $(grep -c "瀏覽器引擎暖機完成" js/*.js | tr "\n" " ")"
  echo "headers.tar members: $(tar -tf engine/assets/headers.tar | grep -E "vgerr.h|__assertion_handler|include/vg.h" | tr "\n" " ")"
  echo "auth_base prewarm tag: $(grep -c "prewarm.js" /app/gdbgui/templates/_auth_base.html)"
  echo "compileTimeoutMs: $(grep -o "compileTimeoutMs: *[0-9_]*" engine/index.js | head -3 | tr "\n" " ")"'
