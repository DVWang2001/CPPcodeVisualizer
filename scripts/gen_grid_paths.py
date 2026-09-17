"""走方格教案（examples/lessons/走方格_AtCoder_Grid1）的隨機測資產生器。

上課前跑一次，把輸出貼進編輯器的 Standard Input 面板再按 Run：

    python scripts/gen_grid_paths.py                    # 隨機 3~8 列、3~8 行
    python scripts/gen_grid_paths.py --h 5 --w 5 --wall-rate 0.3
    python scripts/gen_grid_paths.py --seed 42   # 想重播同一組測資時用

輸出格式跟 AtCoder dp_h 的官方輸入一模一樣：第一行 h w，接著 h 行、每行 w 個
字元（. 是通道、# 是牆）。只印測資，不印答案——答案本來就該讓教案自己跑出來，
跟即時課堂填表題「正解在執行當下才抓」是同一個道理（見 AUTHORING_GUIDE §9.5）。

起點 (0,0) 與終點 (h-1,w-1) 保證是通道：兩者是牆的話輸入雖然合法（答案就是
0），但拿來當課堂教材沒有意義，全班會看著一張注定填出全 0 的表。
"""

import argparse
import random
import sys


def gen_grid(h: int, w: int, wall_rate: float, rng: random.Random) -> list[str]:
    grid = [
        ["#" if rng.random() < wall_rate else "." for _ in range(w)] for _ in range(h)
    ]
    grid[0][0] = "."
    grid[h - 1][w - 1] = "."
    return ["".join(row) for row in grid]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--h", type=int, default=None, help="列數（預設隨機 3~8）")
    parser.add_argument("--w", type=int, default=None, help="行數（預設隨機 3~8）")
    parser.add_argument("--wall-rate", type=float, default=0.25, help="每格是牆的機率（預設 0.25）")
    parser.add_argument("--seed", type=int, default=None, help="固定亂數種子，方便重播同一組測資")
    args = parser.parse_args()

    rng = random.Random(args.seed)
    h = args.h if args.h is not None else rng.randint(3, 8)
    w = args.w if args.w is not None else rng.randint(3, 8)

    print(f"{h} {w}")
    for row in gen_grid(h, w, args.wall_rate, rng):
        print(row)


if __name__ == "__main__":
    main()
    sys.exit(0)
