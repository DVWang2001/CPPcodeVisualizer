#!/usr/bin/env bash
# Copy the P1 working files (paths relative to the repo) to lab-david:~/iris-a-tests/p1/files/<path> and the runner
# scripts to ~/iris-a-tests/p1/, then compare sha256 on both sides. Usage: bash sync_p1.sh FILE...
set -eu
REPO="C:/碩士/研究/papper/CPPcodeVisualizer"
HERE="$REPO/experiments/runtime-error-p1"
cd "$REPO"
for f in "$@"; do [ -f "$f" ] || { echo "missing $f"; exit 2; }; done
timeout 60 ssh -o BatchMode=yes lab-david 'rm -rf ~/iris-a-tests/p1/files && mkdir -p ~/iris-a-tests/p1/files'
tar -cf - "$@" | timeout 120 ssh -o BatchMode=yes lab-david 'cd ~/iris-a-tests/p1/files && tar -xf -'
(cd "$HERE" && tar -cf - run_p1.sh suite-*.sh) | timeout 60 ssh -o BatchMode=yes lab-david 'cd ~/iris-a-tests/p1 && tar -xf -'
norm() { sed -E "s/^([0-9a-f]{12})[0-9a-f]* [ *]?/ /"; }
local_sums=$( (sha256sum "$@"; cd "$HERE" && sha256sum run_p1.sh suite-*.sh) | norm | sort)
remote_sums=$(timeout 60 ssh -o BatchMode=yes lab-david "cd ~/iris-a-tests/p1/files && sha256sum $*; cd .. && sha256sum run_p1.sh suite-*.sh" | norm | sort)
if [ "$local_sums" = "$remote_sums" ]; then echo "SYNC OK: $(echo "$local_sums" | wc -l) files identical"; else echo "SYNC MISMATCH"; diff <(echo "$local_sums") <(echo "$remote_sums"); exit 1; fi
