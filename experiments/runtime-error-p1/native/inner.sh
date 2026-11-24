#!/bin/bash
# Runs inside gcc:14 (one-off, --network none). Compiles each case natively with g++ and records how it ends.
set -u
ulimit -c 0
echo "gcc: $(g++ --version | head -1)"
cd /tmp
for f in /w/cases/*.cpp; do
  id=$(basename "$f" .cpp)
  for opt in O0 O2; do
    if ! g++ -std=c++17 -$opt -o "/tmp/$id.$opt" "$f" 2> "/tmp/$id.$opt.cc"; then
      echo "NATIVE $id $opt compile=fail cc=$(base64 -w0 < /tmp/$id.$opt.cc)"; continue
    fi
    bash -c "timeout 10 /tmp/$id.$opt < /w/cases/$id.in > /tmp/$id.$opt.out 2> /tmp/$id.$opt.err; exit \$?" 2> "/tmp/$id.$opt.sh"
    rc=$?
    sig=-; [ "$rc" -gt 128 ] && sig=$(kill -l $((rc - 128)))
    echo "NATIVE $id $opt rc=$rc sig=$sig out=$(base64 -w0 < /tmp/$id.$opt.out) err=$(base64 -w0 < /tmp/$id.$opt.err) sh=$(base64 -w0 < /tmp/$id.$opt.sh) cc=$(base64 -w0 < /tmp/$id.$opt.cc)"
  done
done
