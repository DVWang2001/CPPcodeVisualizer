"""在不凍結 eventlet hub 的前提下執行會阻塞的子行程。

為什麼需要這個模組
------------------
`SocketIO(manage_session=False)`（app.py）沒有指定 async_mode，而 eventlet 有裝，
所以 Flask-SocketIO 選的是 eventlet：

    >>> socketio.init_app(app); socketio.async_mode
    'eventlet'

在 eventlet 模式下，**整個伺服器跑在單一個 OS thread 上**，所有東西都是同一個
hub 上的 greenlet —— 包含 `read_and_forward_gdb_and_pty_output`
（app.py:230 用 `socketio.start_background_task` 起的，那不是 OS thread，
是 greenlet），它負責把**每一個** session 的 GDB／pty 輸出轉發出去。

專案裡沒有任何地方呼叫 `eventlet.monkey_patch()`，因此 `subprocess.run()` 底下的
`os.waitpid()` / `read()` 是真正的阻塞 syscall。一個使用者按下 Run 觸發 15 秒的
gdb pre-run，或 30 秒的編譯，就會把 hub 整個卡住 —— 其他所有使用者的 HTTP 請求
**和 GDB 輸出轉發**全部停擺。實測（見下）reader greenlet 會停滿子行程的整個執行
時間。

做法
----
`eventlet.tpool.execute()` 把阻塞呼叫丟到真正的 OS thread 執行，並在等待期間讓出
hub。量測（容器內，未 monkey-patch，reader greenlet 每 0.05s tick 一次）：

    A 直接 subprocess.run : elapsed 2.00s  reader 停擺 2.051s   <- 現況
    B tpool.execute       : elapsed 2.01s  reader 停擺 0.058s   <- 修好後
    C tpool + timeout=2   : 2.01s 後照常丟 TimeoutExpired，reader 停擺 0.051s

刻意**不**做的事
----------------
不呼叫 `eventlet.monkey_patch()`。那會把 GDB pty I/O 路徑底下的 os.read/select
全部換掉，而那是全專案時序上最敏感的地方（先前三個間歇性 bug 都是它的順序問題）。
tpool 只影響這裡指名的幾個呼叫，pty 路徑一行都沒動。

沒有動到的東西（**故意的**）
----------------------------
`jail_manager._run()`（useradd/userdel）不走這裡。`jail_manager.acquire()` 全程
持有 `threading.RLock`（jail_manager.py:342），而那把鎖**沒有**被 monkey-patch；
如果在持鎖期間讓出 hub，另一個 greenlet 進來搶同一把鎖就會用真正的阻塞方式卡住
整個 hub，換不到任何好處還多了風險。帳號建立本身是毫秒等級，留在原地。

安全性不變
----------
argv 原封不動地交給 `subprocess.run`，所以 `jail_manager.confine()` 疊上的
setpriv（uid/gid）＋ unshare（user/net namespace）＋ wrapper 的 rlimit 完全照舊。
timeout 與逾時後的 kill 也還是由 `subprocess.run` 自己做，語意不變 ——
換的只有「誰在等它」，不是「它怎麼跑」。
"""

import os
import subprocess
import sys

from .sandbox import jail_manager

# tpool 在 import 當下才讀 EVENTLET_THREADPOOL_SIZE，所以要在 import 之前設。
# 併發上限是 GDBGUI_MAX_SESSIONS（預設 24），每個 session 最多同時佔一個編譯／
# pre-run，額外留一點餘裕給 TTS 這類短工作。池子滿了只會排隊，不會失敗。
os.environ.setdefault(
    "EVENTLET_THREADPOOL_SIZE", str(max(20, jail_manager.MAX_SESSIONS + 8))
)


def eventlet_hub_running() -> bool:
    """這個 thread 上是否真的有 eventlet hub 在跑。

    只看已經 import 進來的模組、只讀已經存在的 hub —— 不呼叫 `get_hub()`，
    因為那會「順手建一個」，在 pytest 這種沒有 hub 的情境下反而製造出一個。
    """
    hubs = sys.modules.get("eventlet.hubs")
    if hubs is None:
        return False
    return getattr(hubs._threadlocal, "hub", None) is not None


def run(argv, **kwargs) -> "subprocess.CompletedProcess":
    """`subprocess.run(argv, **kwargs)`，但不會卡住 eventlet hub。

    參數與回傳值跟 `subprocess.run` 一模一樣，`TimeoutExpired` 等例外也照原樣
    往外丟（tpool 會把工作 thread 裡的例外重新拋在呼叫端）。

    沒有 eventlet hub 時（pytest、本機非 socketio 情境）直接呼叫
    `subprocess.run`，行為完全不變。
    """
    if not eventlet_hub_running():
        return subprocess.run(argv, **kwargs)

    from eventlet import tpool

    return tpool.execute(subprocess.run, argv, **kwargs)
