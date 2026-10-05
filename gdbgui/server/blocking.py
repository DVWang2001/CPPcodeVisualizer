"""在不凍結 eventlet hub 的前提下執行會阻塞的子行程。

為什麼需要這個模組
------------------
`SocketIO(manage_session=False)`（app.py）沒有指定 async_mode，而 eventlet 有裝，
所以 Flask-SocketIO 選的是 eventlet：

    >>> socketio.init_app(app); socketio.async_mode
    'eventlet'

在 eventlet 模式下，**整個伺服器跑在單一個 OS thread 上**，所有東西都是同一個
hub 上的 greenlet —— 每一個 HTTP 請求與 socket.io 事件（例如 /lesson_quiz
即時測驗）都是。

專案裡沒有任何地方呼叫 `eventlet.monkey_patch()`，因此 `subprocess.run()` 底下的
`os.waitpid()` / `read()` 是真正的阻塞 syscall。一個要跑好幾秒的子行程（目前是
/tts_audio 的 mpg123／oggenc 轉檔）若直接在 hub 上等，其他所有使用者的請求與
websocket 事件全部停擺。伺服器 GDB 時代的實測（見下）：輪詢 greenlet 會停滿子行程
的整個執行時間。

做法
----
`eventlet.tpool.execute()` 把阻塞呼叫丟到真正的 OS thread 執行，並在等待期間讓出
hub。量測（容器內，未 monkey-patch，輪詢 greenlet 每 0.05s tick 一次）：

    A 直接 subprocess.run : elapsed 2.00s  reader 停擺 2.051s   <- 修之前
    B tpool.execute       : elapsed 2.01s  reader 停擺 0.058s   <- 修好後
    C tpool + timeout=2   : 2.01s 後照常丟 TimeoutExpired，reader 停擺 0.051s

刻意**不**做的事
----------------
不呼叫 `eventlet.monkey_patch()`。當初的理由是伺服器 GDB 的 pty I/O 路徑對時序
極敏感；那條路徑已隨伺服器 GDB 後端移除。是否改成 monkey_patch 是另一個決定，
這裡維持原狀：tpool 只影響這裡指名的幾個呼叫。

行為不變
--------
argv 原封不動地交給 `subprocess.run`。timeout 與逾時後的 kill 也還是由
`subprocess.run` 自己做，語意不變 —— 換的只有「誰在等它」，不是「它怎麼跑」。
"""

import os
import subprocess
import sys
import time

# tpool 在 import 當下才讀 EVENTLET_THREADPOOL_SIZE，所以要在 import 之前設。
# 32 是伺服器 GDB 時代的有效預設值（max(20, 預設 24 個 session + 8)），沿用不變。
# 現在的使用者是 /tts_audio 的轉檔與登入／註冊的密碼雜湊（call()）。
# 池子滿了只會排隊，不會失敗。
os.environ.setdefault("EVENTLET_THREADPOOL_SIZE", "32")


def eventlet_hub_running() -> bool:
    """這個 thread 上是否真的有 eventlet hub 在跑。

    只看已經 import 進來的模組、只讀已經存在的 hub —— 不呼叫 `get_hub()`，
    因為那會「順手建一個」，在 pytest 這種沒有 hub 的情境下反而製造出一個。
    """
    hubs = sys.modules.get("eventlet.hubs")
    if hubs is None:
        return False
    return getattr(hubs._threadlocal, "hub", None) is not None


def call(fn, *args, **kwargs):
    """呼叫一個會阻塞的同步函式，但不卡住 eventlet hub。

    用在 CPU 密集、在 C 層裡不會讓出 GIL 的呼叫上——目前是密碼雜湊
    （`werkzeug.security` 的 scrypt，刻意慢，約 100 ms 一次）。scrypt 若直接在
    hub 上跑，每一次登入或註冊都會讓**所有**使用者的請求與 websocket 事件停擺
    那麼久；而登入沒有速率限制（設計決定），連續打就是一個被放大的 DoS。

    雜湊參數一個都沒動，換的只有「誰在等它」。

    沒有 eventlet hub 時（pytest、本機非 socketio 情境）直接呼叫，行為不變。
    """
    if not eventlet_hub_running():
        return fn(*args, **kwargs)

    from eventlet import tpool

    return tpool.execute(fn, *args, **kwargs)


def sleep(seconds: float) -> None:
    """睡一下，但把 hub 讓給別人。

    有 eventlet hub 時用 `eventlet.sleep`：這個 greenlet 停住，其他請求與
    websocket 事件照跑。用 `time.sleep` 會停住整個 OS 執行緒——在這個沒有 monkey_patch
    的專案裡，那就是停住**所有**使用者。

    沒有 hub 時（pytest）退回 `time.sleep`，語意相同。
    """
    if not eventlet_hub_running():
        time.sleep(seconds)
        return

    import eventlet

    eventlet.sleep(seconds)


def run(argv, **kwargs) -> "subprocess.CompletedProcess":
    """`subprocess.run(argv, **kwargs)`，但不會卡住 eventlet hub。

    參數與回傳值跟 `subprocess.run` 一模一樣，`TimeoutExpired` 等例外也照原樣
    往外丟（tpool 會把工作 thread 裡的例外重新拋在呼叫端）。

    沒有 eventlet hub 時（pytest、本機非 socketio 情境）直接呼叫
    `subprocess.run`，行為完全不變。
    """
    return call(subprocess.run, argv, **kwargs)
