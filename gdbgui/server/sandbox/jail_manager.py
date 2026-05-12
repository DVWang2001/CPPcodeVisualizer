#!/usr/bin/env python3
"""
jail_manager.py — 建立 / 銷毀 chroot 沙盒

可從 Python 程式碼 import，也可直接以 CLI 呼叫：
  python3 jail_manager.py create  <binary> <jail_dir>
  python3 jail_manager.py destroy <jail_dir>

Jail 目錄結構：
  <jail_dir>/
    app/       — 使用者 binary 放置處（執行期路徑 /app/<name>）
    tmp/       — 可寫暫存
    dev/       — null / zero / urandom 裝置節點（root 模式）
    proc/      — bind-mount /proc（root 模式）
    etc/       — ld.so.cache（複製）
    lib/ lib64/ usr/  — 函式庫（root=bind-mount；非root=ldd複製）
    .created   — 建立成功標記
"""

import os
import shutil
import subprocess
import sys
from pathlib import Path


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def _run(cmd: list, **kwargs):
    return subprocess.run(cmd, check=True, capture_output=True, text=True, **kwargs)


def _bind_mount_ro(src: Path, dst: Path) -> bool:
    """嘗試把 src 以唯讀 bind-mount 到 dst；失敗回傳 False。"""
    try:
        dst.mkdir(parents=True, exist_ok=True)
        _run(["mount", "--bind", str(src), str(dst)])
        _run(["mount", "-o", "remount,ro,bind", str(dst)])
        return True
    except Exception:
        return False


def _copy_ldd_deps(binary_path: Path, jail_dir: Path):
    """用 ldd 找出 binary 所需的 .so，複製到 jail 中對應路徑。"""
    try:
        result = _run(["ldd", str(binary_path)])
    except Exception:
        return

    for line in result.stdout.splitlines():
        parts = line.strip().split()
        if "=>" in parts:
            idx = parts.index("=>")
            if idx + 1 < len(parts) and parts[idx + 1] not in ("not", "(not"):
                lib_path = Path(parts[idx + 1])
            else:
                continue
        elif parts and parts[0].startswith("/"):
            # 動態載入器本身，格式：  /lib64/ld-linux-x86-64.so.2 (0x...)
            lib_path = Path(parts[0])
        else:
            continue

        if not lib_path.exists():
            continue

        _install_file(lib_path, jail_dir)

        # 追蹤 symlink 真實目標
        real = lib_path.resolve()
        if real != lib_path and real.exists():
            _install_file(real, jail_dir)


def _install_file(src: Path, jail_dir: Path):
    """把 src 複製到 jail_dir 內對應的相對路徑（若尚未存在）。"""
    try:
        rel = src.relative_to("/")
    except ValueError:
        return
    dst = jail_dir / rel
    if not dst.exists():
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)


# ---------------------------------------------------------------------------
# public API
# ---------------------------------------------------------------------------

def create_jail(binary_path_str: str, jail_dir_str: str) -> bool:
    """
    為 binary_path 在 jail_dir 建立最小化 chroot jail。

    - root 執行：bind-mount 函式庫目錄（唯讀）、建立 /dev 節點、bind-mount /proc
    - 非 root：用 ldd 找依賴並逐一複製進 jail
    回傳 True 表示 jail 已就緒。
    """
    binary_path = Path(binary_path_str)
    jail_dir = Path(jail_dir_str)

    if not binary_path.exists():
        return False

    # 建立基本目錄
    for d in ("app", "tmp", "dev", "proc", "etc"):
        (jail_dir / d).mkdir(parents=True, exist_ok=True)

    # 複製 binary
    binary_dest = jail_dir / "app" / binary_path.name
    shutil.copy2(binary_path, binary_dest)
    os.chmod(binary_dest, 0o755)

    is_root = (os.geteuid() == 0)

    if is_root:
        # bind-mount 常見函式庫目錄（唯讀）
        for lib_dir in ("/lib", "/lib64", "/usr/lib", "/usr/lib64",
                        "/usr/local/lib", "/lib/x86_64-linux-gnu",
                        "/usr/lib/x86_64-linux-gnu"):
            src = Path(lib_dir)
            if src.exists():
                _bind_mount_ro(src, jail_dir / lib_dir.lstrip("/"))

        # 複製 ld.so.cache
        ldcache = Path("/etc/ld.so.cache")
        if ldcache.exists():
            shutil.copy2(ldcache, jail_dir / "etc" / "ld.so.cache")

        # 建立裝置節點
        for name, major, minor, mode in [
            ("null",    1, 3, "666"),
            ("zero",    1, 5, "666"),
            ("urandom", 1, 9, "444"),
        ]:
            node = jail_dir / "dev" / name
            if not node.exists():
                try:
                    _run(["mknod", "-m", mode, str(node), "c",
                          str(major), str(minor)])
                except Exception:
                    pass

        # bind-mount /proc（唯讀）
        _bind_mount_ro(Path("/proc"), jail_dir / "proc")

    else:
        # 非 root：用 ldd 複製所有共享函式庫
        _copy_ldd_deps(binary_path, jail_dir)

        # 複製 ld.so.cache（可能無法讀，忽略失敗）
        ldcache = Path("/etc/ld.so.cache")
        if ldcache.exists():
            try:
                shutil.copy2(ldcache, jail_dir / "etc" / "ld.so.cache")
            except Exception:
                pass

        # 確保有 /usr/lib 軟連結目錄（部分 distro 的 lib 在這裡）
        for usr_lib in ("/usr/lib", "/usr/lib64"):
            src = Path(usr_lib)
            if src.is_dir():
                dst = jail_dir / usr_lib.lstrip("/")
                # 只建目錄，不 mount；_copy_ldd_deps 已用絕對路徑處理過
                dst.mkdir(parents=True, exist_ok=True)

    # 寫入成功標記
    (jail_dir / ".created").touch()
    return True


def destroy_jail(jail_dir_str: str):
    """卸載 bind-mount 並刪除整個 jail 目錄。"""
    jail_dir = Path(jail_dir_str)
    if not jail_dir.exists():
        return

    # 先嘗試 umount（只有 root 模式才有 mount，非 root 直接略過）
    if os.geteuid() == 0:
        for rel in ("proc", "lib", "lib64",
                    "usr/lib", "usr/lib64", "usr/local/lib",
                    "lib/x86_64-linux-gnu", "usr/lib/x86_64-linux-gnu"):
            mp = jail_dir / rel
            if mp.is_dir():
                for flag in ([], ["-l"]):   # normal → lazy
                    try:
                        _run(["umount"] + flag + [str(mp)])
                        break
                    except Exception:
                        pass

    try:
        shutil.rmtree(str(jail_dir))
    except Exception:
        pass


# ---------------------------------------------------------------------------
# CLI entry-point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} create  <binary> <jail_dir>", file=sys.stderr)
        print(f"       {sys.argv[0]} destroy <jail_dir>",           file=sys.stderr)
        sys.exit(1)

    cmd = sys.argv[1]
    if cmd == "create" and len(sys.argv) >= 4:
        ok = create_jail(sys.argv[2], sys.argv[3])
        sys.exit(0 if ok else 1)
    elif cmd == "destroy" and len(sys.argv) >= 3:
        destroy_jail(sys.argv[2])
        sys.exit(0)
    else:
        print("Invalid arguments", file=sys.stderr)
        sys.exit(1)
