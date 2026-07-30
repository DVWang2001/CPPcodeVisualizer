"""read_helper.py — 以 session 帳號讀檔的子行程（由 http_routes 透過 confine() 啟動）

## 這解決什麼

`/read_file` 與 `/get_last_modified_unix_sec` 以前直接在伺服器行程裡做
`os.path.isfile(path)` + `open(path).read()`／`os.path.getmtime(path)`，
而伺服器是 **root**，`path` 直接來自 `request.args`。也就是說那兩條路由等於
「以 root 讀任意檔案」與「以 root 探測任意路徑存不存在、什麼時候改的」。
039c08b 把它們關進登入之後（嚴格變好），但註冊是開放的（約 200 個帳號），
而**同一個 commit** 才剛把 `/var/lib/gdbgui/secret_key` 與密碼雜湊資料庫放上
磁碟：讀到 SECRET_KEY 就能簽出任何人的 session cookie，也就是任何人的
`owner_key()`、任何人的 jail。伺服器以 root 執行時，檔案權限救不了這件事。

## 為什麼是「以呼叫者的身分讀」而不是路徑白名單

檔案系統權限已經正好編碼了正確的政策（容器內、真實 session 帳號實測）：

    READABLE  /usr/include/stdio.h          <- 單步進系統標頭時需要
    READABLE  /usr/include/c++/14/vector    <- 需要
    READABLE  /app/examples/cpp/set_bounds.cpp
    denied    /srv/gdbgui-scratch/<別人>/*  (0700，屬於別的 session 帳號)
    denied    /var/lib/gdbgui/secret_key    (-rw------- root)
    denied    /var/lib/gdbgui/gdbgui.sqlite3
    denied    /etc/shadow

白名單要跟著編譯器版本搬家而維護，不會自動保護之後才新增的祕密，而且還得另外
算出「哪個 scratch 目錄屬於這個呼叫者」。以呼叫者的身分去讀，這三件事都是免費
的，而且重用的是已經有測試的那套隔離機制（sandbox/jail_manager.py）。

## 契約

stdin 收一份 JSON、stdout 回一份 JSON，其餘一律不輸出：

    → {"path": str, "want_content": bool, "start_line": int, "end_line": int}
    ← {"ok": true, "mtime": float}                                  （只要 mtime）
    ← {"ok": true, "mtime": float, "num_lines": int, "lines": [...],
       "truncated": bool}                                           （要內容）
    ← {"ok": false}

**失敗一律只回 `{"ok": false}`**：不帶 errno、不帶路徑、不區分「檔案不存在」與
「沒有權限」。否則那個以 root 探測路徑的 oracle 只是換個形狀活下來——呼叫端
（http_routes）對兩者也回完全相同的訊息，原本的實作則是把 path 直接插進錯誤
訊息裡。診斷資訊走 stderr，只有伺服器日誌看得到。

## 為什麼 stat 也要進來，而且和讀取共用同一個 fd

1. `os.path.isfile` / `os.path.getmtime` 以 root 執行，**本身**就是一個任意路徑的
   存在性與修改時間 oracle。`/get_last_modified_unix_sec` 整條路由就只有它。
   所以兩條路由的**每一次**檔案系統接觸都要降權，不是只有讀內容那一步。
2. open 之後只用 fstat／read、不再用路徑，就沒有 stat→open 之間的 TOCTOU。
   scratch 目錄由不可信的 session 使用者持有，他的程式可以在兩次呼叫之間把檔案
   換成 symlink。
3. 這讓 `/get_last_modified_unix_sec` 與 `/read_file` 的可及範圍**完全相同**。
   單純 `os.stat` 的話 `/etc/shadow` 的 mtime 是拿得到的（`/etc` 人人可 traverse，
   實測 STAT-OK / READ-ERR）；要求「打得開」才回 mtime 是比較緊、也比較好解釋
   的政策，而合法用途（比對自己的 binary 有沒有變新）一點都沒少。

`O_NONBLOCK`：scratch 裡可以放 FIFO，而 `open()` 一個沒有寫入端的 FIFO 會
**永遠卡住**。O_NONBLOCK 讓它立刻回來，接著 `S_ISREG` 把它擋掉（原本的
`os.path.isfile` 也只接受一般檔案）。呼叫端另外還有 subprocess timeout 當第二道網。

## 上限

原本是 `f.read().split("\\n")`——整個檔案先進記憶體，再切出 start_line..end_line。
一個大檔就是一次記憶體耗盡。這裡改成分塊掃描，四道上限見下方常數，超過就截斷
並回 `truncated: true`，**不**變成一種新的錯誤（新的錯誤就是新的可分辨結果）。

## 這支程式碼的環境

由呼叫端以乾淨的環境變數啟動（見 http_routes._child_env），只用標準函式庫，
不 import 專案裡的任何東西——它以不可信 session 帳號的身分執行，能少碰什麼就
少碰什麼。
"""

import json
import os
import stat
import sys

#: 最多從檔案掃描這麼多位元組。超過就停止，num_lines 會是低估值（並標記 truncated）。
MAX_SCAN_BYTES = 8 * 1024 * 1024

#: 最多回傳這麼多位元組的內容。伺服器端還要對這些內容跑 pygments，所以這個上限
#: 同時是記憶體上限與 hub 上的 CPU 上限。
MAX_RETURN_BYTES = 1024 * 1024

#: 最多回傳這麼多行。
MAX_RETURN_LINES = 20000

#: 單一行最多緩衝這麼多位元組（沒有換行的巨大檔案不能把記憶體吃光）。
MAX_LINE_BYTES = 1024 * 1024

CHUNK_BYTES = 64 * 1024

#: stdin 上的請求本來就只有幾百位元組。
MAX_REQUEST_BYTES = 64 * 1024


def _refuse(reason: str) -> int:
    """唯一的失敗出口。stdout 只有 {"ok": false}，理由只走 stderr。"""
    print(reason, file=sys.stderr)
    sys.stdout.write(json.dumps({"ok": False}))
    return 0


def _read_range(fd: int, start_line: int, end_line: int) -> dict:
    """從 fd 掃過整個檔案，回傳總行數與 start_line..end_line（皆為 1-based、含端點）。

    行數的語意刻意與原本的 `f.read().split("\\n")` 一致：以 "\\n" 結尾的檔案
    最後會多出一個空字串元素（"a\\nb\\n" → 3 行）。前端的捲動邊界是照這個數字
    算的，換掉它會讓 SourceCode 的行為悄悄改變。
    """
    lines = []
    returned_bytes = 0
    truncated = False

    def keep(line_no: int, raw: bytes) -> None:
        nonlocal returned_bytes, truncated
        if not (start_line <= line_no <= end_line):
            return
        if len(lines) >= MAX_RETURN_LINES or returned_bytes + len(raw) > MAX_RETURN_BYTES:
            truncated = True
            return
        # 逐行解碼：切點一定落在 "\n" 上，不會切壞 UTF-8 的多位元組序列。
        # errors="replace" 而不是丟例外——例外會變成另一種可分辨的結果。
        lines.append(raw.decode("utf-8", "replace"))
        returned_bytes += len(raw) + 1

    scanned = 0
    line_no = 0
    buf = b""
    while True:
        if scanned >= MAX_SCAN_BYTES:
            truncated = True
            break
        chunk = os.read(fd, min(CHUNK_BYTES, MAX_SCAN_BYTES - scanned))
        if not chunk:
            break
        scanned += len(chunk)
        buf += chunk
        while True:
            newline = buf.find(b"\n")
            if newline < 0:
                break
            raw, buf = buf[:newline], buf[newline + 1:]
            line_no += 1
            keep(line_no, raw)
        if len(buf) > MAX_LINE_BYTES:
            # 一行長到這種程度只可能是產生出來的檔案。丟掉超出的部分，
            # 行號仍然正確（後面的 "\n" 照樣會被找到）。
            buf = buf[:MAX_LINE_BYTES]
            truncated = True

    # 最後一段（可能是空字串）——這正是 split("\n") 多出來的那個元素。
    line_no += 1
    keep(line_no, buf)

    return {"num_lines": line_no, "lines": lines, "truncated": truncated}


def main() -> int:
    try:
        request = json.loads(sys.stdin.read(MAX_REQUEST_BYTES) or "{}")
        path = request["path"]
        if not isinstance(path, str) or not path:
            raise ValueError("path must be a non-empty string")
        want_content = bool(request.get("want_content"))
        start_line = int(request.get("start_line") or 0)
        end_line = int(request.get("end_line") or 0)
    except Exception as exc:  # noqa: BLE001 —— 任何壞請求都只是 {"ok": false}
        return _refuse(f"bad request: {exc.__class__.__name__}")

    try:
        fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | getattr(os, "O_CLOEXEC", 0))
    except OSError as exc:
        # ENOENT 與 EACCES 在這裡就合流了：呼叫端看到的只有 {"ok": false}。
        return _refuse(f"open failed with errno {exc.errno}")

    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            return _refuse("not a regular file")
        result = {"ok": True, "mtime": st.st_mtime}
        if want_content:
            result.update(_read_range(fd, start_line, end_line))
    except OSError as exc:
        return _refuse(f"read failed with errno {exc.errno}")
    finally:
        os.close(fd)

    sys.stdout.write(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
