#!/usr/bin/env bash
# chain3.sh: rebuild the builder image at BASE, then the after_view test (with the pointer case) and pointers.test.mjs
# with the change mounted. Start: bash go.sh bash ./chain3.sh   (chain3.pid, run-chain3.log, CHAIN3-EXIT=)
cd "$(dirname "$0")" || exit 3
echo $$ > chain3.pid
exec >> run-chain3.log 2>&1
echo "== chain3 start $(date -Is)"
bash ./frontend_check.sh build; echo "build rc=$?"
bash ./engine_check.sh node green2 tests/engine/localgdb/after_view.test.mjs tests/engine/localgdb/pointers.test.mjs; echo "node rc=$?"
echo "CHAIN3-EXIT=0"
