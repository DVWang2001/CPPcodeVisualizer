#!/bin/bash
# 在正式機容器內用 GDB 擷取參考答案（含表達式求值）。用法：source run_ref3.sh; run_ref3 名稱 程式.cpp next|step 全域變數逗號清單 輸入檔 [表達式.json]
run_ref3() {
  local n=$1 f=$2 mode=$3 g=$4 inp=$5 ex=$6 caps=$7
  local b; b=$(basename "$f" .cpp); local ib; ib=$(basename "$inp")
  scp -q gdbref.py "$f" "$inp" ${ex:+"$ex"} lab-david:/tmp/
  local exname=""; [ -n "$ex" ] && exname=$(basename "$ex")
  ssh lab-david "C=cppcodevisualizer-gdbgui-1
    docker cp /tmp/gdbref.py \$C:/tmp/gdbref.py; docker cp /tmp/$b.cpp \$C:/tmp/$b.cpp; docker cp /tmp/$ib \$C:/tmp/$ib
    [ -n '$exname' ] && docker cp /tmp/$exname \$C:/tmp/$exname
    docker exec \$C sh -c \"g++ -std=c++17 -g -O0 -o /tmp/$b.bin /tmp/$b.cpp && REF_EXPRS=\$( [ -n '$exname' ] && echo /tmp/$exname ) REF_CAPS='$caps' REF_GLOBALS='$g' REF_MODE=$mode REF_IN=/tmp/$ib REF_OUT=/tmp/${b}_ref.json gdb -q -batch -x /tmp/gdbref.py /tmp/$b.bin 2>&1 | tail -1\"
    docker cp \$C:/tmp/${b}_ref.json /tmp/${b}_ref.json
    docker exec \$C sh -c \"rm -f /tmp/gdbref.py /tmp/$b.cpp /tmp/$ib /tmp/$b.bin /tmp/${b}_ref.json /tmp/$exname\""
  scp -q lab-david:/tmp/${b}_ref.json "./ref_$n.json"
  ssh lab-david "rm -f /tmp/gdbref.py /tmp/$b.cpp /tmp/$ib /tmp/${b}_ref.json /tmp/$exname"
}
