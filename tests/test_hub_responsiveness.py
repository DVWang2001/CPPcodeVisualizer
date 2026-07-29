"""回歸測試：跑子行程時，eventlet hub 不可以停擺。

背景見 gdbgui/server/blocking.py。伺服器是 eventlet 單執行緒，
`read_and_forward_gdb_and_pty_output`（app.py:230）是 hub 上的 **greenlet**，
不是 OS thread，而它負責轉發**每一個** session 的 GDB／pty 輸出。所以任何一個
沒讓出 hub 的阻塞子行程（編譯 30s、gdb pre-run 15s），都會讓其他所有使用者的
HTTP 請求與 GDB 輸出一起卡住。實測（見 README of blocking.py）第二個使用者的
`GET /` 從 2-3ms 惡化到 2374ms，另一個使用者的 GDB 單步從 51ms 惡化到 2782ms。

為什麼整批丟到**一個**子行程跑
------------------------------
兩個理由，方向相反，所以剛好收斂到「一個子行程、跑完三個情境」：

1. 一定要在子行程裡跑。`eventlet.spawn()` 會在 main thread 建立一個**會留下來**
   的 hub；pytest 整個 suite 共用一個行程，hub 一旦建立，後面所有測試裡的
   `blocking.run()` 就都會改走 tpool。測試不該改變它以外的東西的執行模型。

2. 但也只能開**一個**。實測開三個子行程（每個情境一個）會讓
   test_signal_authz 間歇性失敗 —— 它記下 gdb 的 pid 再去檢查擁有者，而大量
   建立／回收行程會加速 PID 重用，讓那個檢查看到別人的行程。那是既有的競態
   （見報告），但新測試沒有理由去踩它。

所以：一個乾淨的子行程，依序跑完三個情境，只把量到的數字帶回來。
"""

import json
import subprocess
import sys
from pathlib import Path

import pytest

pytest.importorskip("eventlet")

REPO_ROOT = Path(__file__).resolve().parent.parent

SLEEP_SECONDS = 1.5
TICK = 0.05
# 停擺容忍值。理想是一個 tick（0.05s）；放寬到 0.5s 容忍 CI 排程抖動，
# 但仍遠小於 SLEEP_SECONDS，足以區分「有讓出 hub」與「整段卡死」。
MAX_ACCEPTABLE_STALL = 0.5

# 一個子行程跑完全部三個情境，把結果一起帶回來。
_SCENARIO = r'''
import json, subprocess, sys, time
import eventlet
sys.path.insert(0, {repo!r})
from gdbgui.server import blocking

SLEEP = {sleep}
TICK = {tick}

ticks = []
stop = [False]


def loop():
    # 模仿 read_and_forward_gdb_and_pty_output 的輪詢 greenlet
    while not stop[0]:
        ticks.append(time.time())
        eventlet.sleep(TICK)


eventlet.spawn(loop)
eventlet.sleep(0.3)   # 讓 ticker 先穩定跑起來


def measure(fn):
    """跑 fn，回傳 (結果, 耗時, 這段期間 hub 的最大停擺)。"""
    t0 = time.time()
    try:
        value = fn()
    finally:
        t1 = time.time()
        eventlet.sleep(0.3)   # 收尾的 tick
    # 最大停擺 = 與 [t0, t1] **重疊** 的相鄰 tick 間隔。
    # 不能只看落在視窗**內**的 tick：hub 整個卡死時視窗內一個 tick 都沒有，
    # 那樣會算出 0，反而讓壞掉的情況看起來完美。
    worst = 0.0
    for earlier, later in zip(ticks, ticks[1:]):
        if later >= t0 and earlier <= t1:
            worst = max(worst, later - earlier)
    return value, t1 - t0, worst


def via_blocking():
    return blocking.run(["sleep", str(SLEEP)]).returncode


def via_timeout():
    try:
        blocking.run(["sleep", "30"], timeout=SLEEP)
        return False
    except subprocess.TimeoutExpired:
        return True


def via_plain():
    return subprocess.run(["sleep", str(SLEEP)]).returncode


out = {{"hub": blocking.eventlet_hub_running()}}
for name, fn in (("blocking", via_blocking), ("timeout", via_timeout), ("plain", via_plain)):
    value, elapsed, stall = measure(fn)
    out[name] = {{"value": value, "elapsed": elapsed, "stall": stall}}
stop[0] = True
print("RESULT " + json.dumps(out))
'''


@pytest.fixture(scope="module")
def measured() -> dict:
    """在一個乾淨的子行程裡跑完三個情境（理由見模組 docstring）。"""
    script = _SCENARIO.format(repo=str(REPO_ROOT), sleep=SLEEP_SECONDS, tick=TICK)
    proc = subprocess.run(
        [sys.executable, "-c", script],
        capture_output=True,
        text=True,
        timeout=180,
        cwd=str(REPO_ROOT),
    )
    line = [l for l in proc.stdout.splitlines() if l.startswith("RESULT ")]
    assert line, f"子行程沒有回報結果\nstdout:\n{proc.stdout}\nstderr:\n{proc.stderr}"
    return json.loads(line[0][len("RESULT "):])


def test_blocking_run_keeps_the_hub_responsive(measured):
    """blocking.run 執行子行程時，ticker greenlet 必須持續在跑。"""
    r = measured["blocking"]
    assert measured["hub"], "測試前提：子行程裡必須真的有 eventlet hub"
    assert r["value"] == 0
    assert r["elapsed"] >= SLEEP_SECONDS, "子行程必須真的跑完，不是被略過"
    assert r["stall"] < MAX_ACCEPTABLE_STALL, (
        f"hub 停擺 {r['stall']:.3f}s（子行程 {r['elapsed']:.2f}s）。"
        " 這代表阻塞呼叫沒有讓出 hub —— 其他 session 的 GDB 輸出在這段時間"
        " 全部停止轉發。檢查該呼叫是不是繞過了 blocking.run。"
    )


def test_blocking_run_still_enforces_timeout(measured):
    """讓出 hub 不可以換掉 timeout 語意：照樣要丟 TimeoutExpired。"""
    r = measured["timeout"]
    assert r["value"] is True, "timeout 必須照常觸發"
    assert r["elapsed"] < SLEEP_SECONDS + 3, "timeout 必須準時，不能拖到子行程自己結束"
    assert r["stall"] < MAX_ACCEPTABLE_STALL


def test_plain_subprocess_run_does_stall_the_hub(measured):
    """負向對照：直接 subprocess.run **必定**卡住 hub。

    這一條主張的是「我們要修掉的那個病確實存在」。它如果哪天失敗了，代表執行
    模型變了（例如有人加了 monkey_patch()，或 async_mode 不再是 eventlet），
    那時 blocking.py 的整套理由都要重新檢視 —— 不要直接把這個測試刪掉。
    """
    r = measured["plain"]
    assert r["stall"] >= SLEEP_SECONDS * 0.8, (
        f"預期未 patch 的 subprocess.run 會讓 hub 停擺約 {SLEEP_SECONDS}s，"
        f" 實際只有 {r['stall']:.3f}s。執行模型可能變了，請重新檢視 blocking.py。"
    )
