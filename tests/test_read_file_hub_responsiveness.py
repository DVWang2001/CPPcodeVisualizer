"""跑 /read_file 的降權子行程時，eventlet hub 不可以停擺。

為什麼要獨立一條
----------------
`tests/test_hub_responsiveness.py` 證明的是「`blocking.run` 會讓出 hub」。
這裡證明的是另一件事：**這條路由真的走 `blocking.run`**。

修 /read_file 的做法是「每一次檔案系統接觸都丟到一個降權子行程裡做」——也就是
在一條每次 GDB 停下來都會被打到的路徑上，新增了一個 fork+exec。伺服器是 eventlet
單執行緒，`read_and_forward_gdb_and_pty_output`（app.py）是同一個 hub 上的
**greenlet**，負責轉發**每一個** session 的 GDB／pty 輸出。要是這裡寫成同步的
`subprocess.run`，一個人瀏覽原始碼就會讓所有人的 GDB 輸出停擺。

怎麼量
------
用一支**會睡 1.5 秒**的假 helper 取代真的那支（`http_routes._READ_HELPER`），
其餘全部是正版：真的 Flask 路由、真的 `_run_confined`、真的 `confine()`、
真的 session 帳號。子行程的耗時因此是確定的，量到的停擺才有意義——真的 helper
只跑幾十毫秒，量不出訊號。

同一個子行程裡再跑一次負向對照（把 `blocking` 換成同步的 subprocess.run），
證明這個 harness 真的分辨得出好壞。

為什麼整批塞進**一個**子行程：理由與 test_hub_responsiveness.py 的模組
docstring 相同（hub 一旦在 pytest 行程裡建立就回不去；子行程開太多會加速 PID
重用，讓 test_signal_authz 間歇性失敗）。
"""

import json
import subprocess
import sys
from pathlib import Path

import pytest

pytest.importorskip("eventlet")

from gdbgui.server.sandbox import jail_manager  # noqa: E402

pytestmark = pytest.mark.skipif(
    not jail_manager.isolation_available(),
    reason="confined file reads need root + setpriv/unshare/useradd",
)

REPO_ROOT = Path(__file__).resolve().parent.parent

SLEEP_SECONDS = 1.5
TICK = 0.05
MAX_ACCEPTABLE_STALL = 0.5


_SCENARIO = r'''
import json, os, subprocess, sys, time, types
import eventlet
sys.path.insert(0, {repo!r})

SLEEP = {sleep}
TICK = {tick}

# 會睡覺的假 helper。契約與 sandbox/read_helper.py 一樣（stdin 收 JSON、
# stdout 回 JSON），只是慢得可以量。
SLOW_HELPER = "/tmp/gdbgui_slow_read_helper.py"
with open(SLOW_HELPER, "w") as fh:
    fh.write(
        "import json, sys, time\n"
        "sys.stdin.read()\n"
        "time.sleep(%r)\n" % SLEEP
        + "sys.stdout.write(json.dumps(dict("
        "ok=True, mtime=1.0, num_lines=1, lines=[''], truncated=False)))\n"
    )
os.chmod(SLOW_HELPER, 0o755)

# conftest 一定要**最先** import：它在 import 時把 GDBGUI_DATA_DIR 指到一個
# 暫存目錄並套 migration，而 gdbgui.server.app 在 import 時就會 db.initialize()。
# 反過來的話 app 會開真正的 /var/lib/gdbgui，conftest 再把 DATA_DIR 換掉，
# 結果就是一個沒有 users 資料表的空資料庫。
from tests.conftest import register_user
from gdbgui.server import blocking, http_routes
from gdbgui.server.app import app
from gdbgui.server.sandbox import jail_manager

app.config["gdb_command"] = "gdb"
user = register_user(app)
jail = jail_manager.acquire(user.owner_key)
assert jail is not None, "測試前提：呼叫者必須有 live jail"

http_routes._READ_HELPER = SLOW_HELPER

ticks = []
stop = [False]


def loop():
    # 模仿 read_and_forward_gdb_and_pty_output 的輪詢 greenlet
    while not stop[0]:
        ticks.append(time.time())
        eventlet.sleep(TICK)


eventlet.spawn(loop)
eventlet.sleep(0.3)


def measure(fn):
    t0 = time.time()
    try:
        value = fn()
    finally:
        t1 = time.time()
        eventlet.sleep(0.3)
    # 最大停擺 = 與 [t0, t1] **重疊**的相鄰 tick 間隔（hub 全死時視窗內沒有
    # 任何 tick，只看視窗內會算出 0，反而讓壞掉的情況看起來完美）。
    worst = 0.0
    for earlier, later in zip(ticks, ticks[1:]):
        if later >= t0 and earlier <= t1:
            worst = max(worst, later - earlier)
    return value, t1 - t0, worst


def read_file_route():
    response = user.http.get(
        "/read_file",
        query_string={{
            "path": "/usr/include/stdio.h",
            "start_line": 1,
            "end_line": 1,
            "highlight": "false",
        }},
        headers={{"x-csrftoken": user.csrf}},
    )
    return response.status_code


out = {{"hub": blocking.eventlet_hub_running()}}

value, elapsed, stall = measure(read_file_route)
out["route"] = {{"value": value, "elapsed": elapsed, "stall": stall}}

# 負向對照：把讓出 hub 的那一層拿掉，同一條路由、同一個 harness。
http_routes.blocking = types.SimpleNamespace(run=subprocess.run)
value, elapsed, stall = measure(read_file_route)
out["plain"] = {{"value": value, "elapsed": elapsed, "stall": stall}}
http_routes.blocking = blocking

stop[0] = True
jail_manager.release(user.owner_key)
print("RESULT " + json.dumps(out))
'''


@pytest.fixture(scope="module")
def measured() -> dict:
    script = _SCENARIO.format(repo=str(REPO_ROOT), sleep=SLEEP_SECONDS, tick=TICK)
    proc = subprocess.run(
        [sys.executable, "-c", script],
        capture_output=True,
        text=True,
        timeout=300,
        cwd=str(REPO_ROOT),
    )
    line = [l for l in proc.stdout.splitlines() if l.startswith("RESULT ")]
    assert line, f"子行程沒有回報結果\nstdout:\n{proc.stdout}\nstderr:\n{proc.stderr}"
    return json.loads(line[0][len("RESULT "):])


def test_read_file_does_not_stall_the_hub(measured):
    r = measured["route"]
    assert measured["hub"], "測試前提：子行程裡必須真的有 eventlet hub"
    assert r["value"] == 200, "路由必須真的成功，否則量到的是「快速失敗」"
    assert r["elapsed"] >= SLEEP_SECONDS, "降權子行程必須真的跑完，不是被略過"
    assert r["stall"] < MAX_ACCEPTABLE_STALL, (
        f"hub 停擺 {r['stall']:.3f}s（子行程 {r['elapsed']:.2f}s）。"
        " 一個人瀏覽原始碼會讓所有 session 的 GDB 輸出在這段時間停止轉發。"
        " 檢查 /read_file 是不是繞過了 blocking.run。"
    )


def test_the_harness_can_actually_detect_a_stall(measured):
    """負向對照：拿掉 blocking 這一層，同一條路由**必定**卡住 hub。

    沒有這一條，上面那條可能只是因為量不到東西而通過。
    """
    r = measured["plain"]
    assert r["stall"] >= SLEEP_SECONDS * 0.8, (
        f"預期同步的 subprocess.run 會讓 hub 停擺約 {SLEEP_SECONDS}s，"
        f" 實際只有 {r['stall']:.3f}s —— 這個 harness 量不出停擺，"
        " 上面那條測試因此沒有意義。"
    )
