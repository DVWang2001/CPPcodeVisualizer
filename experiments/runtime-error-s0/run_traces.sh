#!/usr/bin/env bash
# IRIS runtime-error S0, extra phase: full traces for the visual mock-ups (traces.mjs). Waits until run_s0.sh "all"
# has finished (its log ends with EXIT=), so the timing numbers of the main run are not disturbed.
# Start: nohup bash ~/iris-a-tests/errspike/run_traces.sh [now] > /dev/null 2>&1 < /dev/null &
set -u
BASE="$HOME/iris-a-tests/errspike"
IMG=iris-preview:errspike-builder
cd "$BASE" || exit 3
exec >>"$BASE/run-traces.log" 2>&1
echo "== traces start $(date -Is)"
# "now": run beside the main phase with 1 CPU (the main run keeps its 2), for the mock-ups; its timing rows then
# overlap this job, which is recorded here. Without "now": wait until the main phase has finished.
CPUS=2
if [ "${1:-}" = now ]; then
  CPUS=1
  echo "running beside the main phase (1 CPU); main phase log tail: $(tail -n 1 "$BASE/run-all.log")"
else
  for i in $(seq 1 360); do tail -n 1 "$BASE/run-all.log" 2>/dev/null | grep -q '^EXIT=' && break; sleep 30; done
  tail -n 1 "$BASE/run-all.log" | grep -q '^EXIT=' || { echo "the all phase did not finish within 3 hours"; echo "EXIT=2"; exit 2; }
  echo "all phase finished: $(tail -n 1 "$BASE/run-all.log")"
fi
echo "online: $(ss -Htn state established '( sport = :443 or sport = :5000 )' | wc -l)"
SAN_IDS=div0_input,div0_const,div0_unused,mod0_loop,mod0_input,intmin_div,vec_oob,vec_at,vec_empty_back,vec_pop_empty,stack_empty_top,queue_empty_front,str_oob,substr_throw,stoi_bad,null_write,null_read,missing_return,assert_fail,abort_call,inf_recursion,deep_recursion,double_delete,use_after_free,sort_bad_cmp,huge_vector,vla_neg,unsigned_wrap,cin_fail,uninit_read,iter_invalid,ovf_loop,ex_err_null_deref,ex_err_double_free,ex_err_dangling_ptr,ex_err_uninit,ex_err_iterator_invalidation
REC_IDS=ovf_add,ovf_fact,ovf_loop,arr_oob_write,arr_oob_read,arr2d_oob,shift_big,float2int,unsigned_wrap,ex_err_int_overflow,ex_err_array_oob
for cfg in san sanrec; do
  ids=$SAN_IDS; [ "$cfg" = sanrec ] && ids=$REC_IDS
  t0=$(date +%s)
  docker run --rm --name "errspike-traces-$cfg" --cpus "$CPUS" -m 3g --network none --security-opt no-new-privileges:true \
    --user "$(id -u):$(id -g)" -e HOME=/tmp -e REPO=/app -v "$BASE:/spike" -w /spike \
    "$IMG" node traces.mjs "$cfg" "$ids" > "$BASE/log-traces-$cfg.txt" 2>&1
  echo "traces $cfg rc=$? $(( $(date +%s) - t0 )) s: $(tail -n 1 "$BASE/log-traces-$cfg.txt")"
done
echo "live StartedAt: $(docker inspect -f '{{.State.StartedAt}}' cppcodevisualizer-gdbgui-1)  login: $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:5001/login)"
echo "EXIT=0"
