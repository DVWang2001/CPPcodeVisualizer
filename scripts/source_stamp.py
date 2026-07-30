#!/usr/bin/env python3
"""印出「會進到 image 裡的原始碼」的指紋。

build 時把它寫進 /app/.build-stamp，e2e 啟動前在本機再算一次做比對。兩邊
不同就代表容器不是從目前的工作區建出來的——測試結果不能信。

這不是為了修 Docker 快取（快取本身是對的，實測改 .tsx 會重建 bundle），
而是為了讓「我到底在測哪一版」變成一秒可答的問題。這個 session 有三次
除錯是被這個問題誤導的，包含一次是被無效的探針誤導。
"""
import hashlib
import os
import sys

# 只涵蓋會影響執行結果的東西。文件、截圖、論文素材變動不該讓 stamp 改變，
# 否則它會每天都不一樣、大家就開始忽略它。
ROOTS = ["gdbgui/src", "gdbgui/server", "gdbgui/templates", "gdbgui/static/css", "tests"]
FILES = ["requirements.txt", "Dockerfile.gdbgui", "webpack.config.js", "package.json", "setup.py"]
SKIP_DIRS = {"__pycache__", "node_modules", ".pytest_cache"}
SKIP_SUFFIX = (".pyc", ".pyo")


def _feed(h, path, repo):
    with open(path, "rb") as f:
        h.update(os.path.relpath(path, repo).replace("\\", "/").encode())
        h.update(b"\0")
        h.update(f.read())
        h.update(b"\0")


def stamp(repo="."):
    h = hashlib.sha256()
    for root in ROOTS:
        base = os.path.join(repo, root)
        if not os.path.isdir(base):
            continue
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS)
            for name in sorted(filenames):
                if name.endswith(SKIP_SUFFIX):
                    continue
                _feed(h, os.path.join(dirpath, name), repo)
    for name in FILES:
        path = os.path.join(repo, name)
        if os.path.isfile(path):
            _feed(h, path, repo)
    return h.hexdigest()[:16]


if __name__ == "__main__":
    print(stamp(sys.argv[1] if len(sys.argv) > 1 else "."))
