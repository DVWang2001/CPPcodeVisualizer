"""把 examples/lessons/ 底下的教案 bundle 匯入某個帳號的教案庫。

    docker compose exec gdbgui python scripts/import_lessons.py <user_id>

為什麼需要這支腳本：教案庫是資料庫裡的 `lessons` 表，跟著 gdbgui-data volume 走；
examples/lessons/ 是 git 裡的檔案。兩者刻意分開（見 db.py 檔頭），所以新部署一台
機器之後教案庫是空的，要有一條把檔案灌進資料庫的路。

**冪等**：以標題比對，已經存在的就跳過。重跑不會產生重複，也不會覆蓋掉老師在
網頁上對那篇教案做過的修改——要更新請在網頁上編輯，不要用這支腳本蓋回去。

標題用**資料夾名**（如「stack經典_Rails」）而不是檔名（stack_rails.json）：
資料夾名是給人看的，而且同一個資料夾裡的 .cpp/input.txt 屬於同一個案例。
"""

import json
import sys
from pathlib import Path

from gdbgui.server import db

LESSONS_DIR = Path(__file__).resolve().parent.parent / "examples" / "lessons"


def bundles():
    """(標題, bundle dict) —— 每個案例資料夾取其中唯一的 .json。"""
    for case_dir in sorted(p for p in LESSONS_DIR.iterdir() if p.is_dir()):
        found = sorted(case_dir.glob("*.json"))
        if len(found) != 1:
            print(f"跳過 {case_dir.name}：找到 {len(found)} 個 .json，預期剛好 1 個")
            continue
        with found[0].open(encoding="utf-8") as f:
            yield case_dir.name, json.load(f)


def main(user_id: int) -> int:
    existing = {row["title"] for row in db.lessons_for_user(user_id)}
    created = skipped = 0

    for title, bundle in bundles():
        if title in existing:
            print(f"跳過   {title}（已存在）")
            skipped += 1
            continue
        # 與伺服器存教案時同一種序列化（http_routes.py），避免同樣的內容因為
        # 空白或跳脫方式不同而在 diff / hash 上看起來不一樣。
        bundle_json = json.dumps(bundle, ensure_ascii=False, separators=(",", ":"))
        lesson_id = db.create_lesson(user_id, title, bundle_json)
        print(f"匯入   {title}  → lesson id {lesson_id}")
        created += 1

    print(f"\n完成：新增 {created} 篇，跳過 {skipped} 篇")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2 or not sys.argv[1].isdigit():
        sys.exit(f"用法：{sys.argv[0]} <user_id>")
    sys.exit(main(int(sys.argv[1])))
