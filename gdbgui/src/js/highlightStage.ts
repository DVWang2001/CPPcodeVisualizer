// ── 指導欄容器高亮的「暫存區 → 一次換上」──────────────────────────────
// 純邏輯，不碰 store / React / GDB，方便單元測試。
//
// 為什麼需要它：graphics_instruction 每個停駐點都會重算 `{dp[i][j]:lightblue}` 這類
// 帶索引的 token，而索引的值（i、j）要向 GDB 要，是非同步的。原本一開始就把該容器的
// 高亮清成 []，等值回來才一個個補上——這段空窗裡只要有任何一次重繪，格子就會暗一下
// 再亮起來，即使前後兩步要亮的其實是同一格。
//
// 現在改成：新的高亮先進暫存區，該容器的 token 全部算完才一次換上；換上去的內容跟
// 現在畫面上的一樣就什麼都不做（不換陣列、不要求重繪）。所以「這一行跟前一步亮同樣的
// 格子」時，畫面上完全沒有中間狀態。

export type HighlightEntry = { index: number; color: string };

function same(a: HighlightEntry[] | undefined, b: HighlightEntry[]): boolean {
  return !!a && a.length === b.length && a.every((e, i) => e.index === b[i].index && e.color === b[i].color);
}

export class HighlightStage {
  private expected = new Map<string, number>();
  private staged = new Map<string, HighlightEntry[]>();

  /**
   * @param live     畫面讀的那張表（global_variable.__latest_highlights）
   * @param onChange 有容器的高亮真的換掉時呼叫（用來要求重繪）
   */
  constructor(private live: Map<string, HighlightEntry[]>, private onChange: () => void) {}

  /** 預掃描：這個容器本次多一個帶索引的 token，要等它的結果。 */
  expect(name: string): void {
    this.expected.set(name, (this.expected.get(name) || 0) + 1);
  }

  /** 一個 token 的索引算出來了，加進暫存區。這是該容器最後一個 token 時就換上。 */
  add(name: string, entry: HighlightEntry): void {
    const list = this.staged.get(name) || [];
    list.push(entry);
    this.staged.set(name, list);
    this.settle(name);
  }

  /** 一個 token 沒有產生高亮（例如索引不是數字）。仍然算「這個 token 有結果了」。 */
  skip(name: string): void {
    this.settle(name);
  }

  /**
   * 收尾：還沒湊齊的容器也照現有的換上（等不到的 token 視為沒有高亮）。
   * 這是原本「一開始就清空」語意的保險，確保不會有高亮永遠停在舊的位置。
   */
  flush(): void {
    for (const name of Array.from(this.expected.keys())) this.commit(name);
  }

  private settle(name: string): void {
    const left = (this.expected.get(name) ?? 1) - 1;
    this.expected.set(name, left);
    if (left <= 0) this.commit(name);
  }

  private commit(name: string): void {
    this.expected.delete(name);
    const next = this.staged.get(name) || [];
    this.staged.delete(name);
    if (same(this.live.get(name), next)) return; // 前後一樣：不動，畫面沒有任何中間狀態
    this.live.set(name, next); // 換新陣列，不改動畫面手上正在用的那個
    this.onChange();
  }
}
