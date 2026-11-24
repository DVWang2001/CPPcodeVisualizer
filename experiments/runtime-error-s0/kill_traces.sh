#!/usr/bin/env bash
# Stop the waiting run_traces.sh (exact command-line match, so this script and the ssh shell are never matched).
ps -eo pid=,args= | awk '$2 == "bash" && $3 == "/home/david/iris-a-tests/errspike/run_traces.sh" && NF == 3 {print $1}' | while read -r pid; do
  echo "killing run_traces.sh pid $pid"; kill "$pid"
done
sleep 1
ps -eo pid=,args= | grep -c "[r]un_traces.sh" || true
echo "EXIT=0"
