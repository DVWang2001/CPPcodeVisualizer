"""診斷用：把 /gdb_listener 上的事件寫成 JSONL（S0 黃金樣本用）。預設關閉。

開關是旗標檔 ``/tmp/gdbgui_record_on``（存在才記，刪掉就停，不必重啟）；輸出 ``/tmp/gdbgui_events.jsonl``。
寫入時就遮蔽 run_token / csrf_token，且不記 query string。每筆帶 ``sid``（client id 的雜湊）以便事後只取單一連線。
ponytail: 沒有輪替與大小上限，僅供短時間手動開啟；長期使用要加。
"""
import hashlib
import json
import os
import time

FLAG = "/tmp/gdbgui_record_on"
OUT = "/tmp/gdbgui_events.jsonl"
_SECRET_KEYS = {"run_token", "csrf_token", "token"}


def _scrub(o):
    if isinstance(o, dict):
        return {k: ("<redacted>" if k in _SECRET_KEYS and isinstance(v, str) else _scrub(v)) for k, v in o.items()}
    if isinstance(o, list):
        return [_scrub(x) for x in o]
    return o


def rec(direction, name, data, sid=None):
    """direction: 'C>S' 或 'S>C'。任何錯誤都吞掉，不能影響正常流程。"""
    try:
        if not os.path.exists(FLAG):
            return
        row = {
            "t": round(time.time(), 3),
            "dir": direction,
            "name": name,
            "sid": hashlib.sha256(str(sid).encode()).hexdigest()[:8] if sid else None,
            "data": _scrub(data),
        }
        with open(OUT, "a", encoding="utf8") as f:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
    except Exception:
        pass
