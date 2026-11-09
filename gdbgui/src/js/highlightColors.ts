// 老師在教案裡指定的高亮色（//@guide 的 {dp[i]:lightblue}、->orange、呼叫歷史圖的
// 自訂標籤顏色），畫到畫面上之前一律經過這張表，換成設計方向 A 的柔和底色＋同色系
// 深框線。以前顏色名稱直接當 CSS 顏色：lime 是螢光綠 #00ff00，淺色節點上的白字幾乎
// 看不見。
//
// 只在「畫」的時候查表。教案資料、pull:／pop: 動畫比對格子用的都還是顏色「名稱」
// （computePullOffsets、effectivePopGen 靠名稱找格子），所以回傳值保留 name：
// 呼叫端拿 name 當身分、拿 bg／border 上色，兩者不能混用。
//
// 表裡每個底色配 --ink（#1e1b2e）都至少 11.3:1，所以格子與節點裡的字一律用 --ink。
// 表裡沒有的名稱（例如 cyan、#ff0000）原樣通過，跟以前一樣；known=false 讓呼叫端
// 保留原本的字色（深色的自訂色上仍要白字）。

export type HighlightPaint = {
  /** 教案裡寫的原始名稱，當身分用（pop:／pull: 比對），不要拿來上色。 */
  name: string;
  bg: string;
  border: string;
  /** 表裡有這個顏色（或 default）：底色夠淡，字用 --ink。 */
  known: boolean;
};

export const HIGHLIGHT_TABLE: Readonly<Record<string, { bg: string; border: string }>> = {
  lightblue: { bg: "#c6e2fa", border: "#2f7fc8" },
  orange: { bg: "#ffcb8f", border: "#d9730d" },
  lime: { bg: "#d3ee97", border: "#5e9614" },
  pink: { bg: "#f8cbdf", border: "#c2457f" },
  yellow: { bg: "#ffe580", border: "#c99a00" },
  green: { bg: "#d7f0df", border: "#2d7a4e" },
  red: { bg: "#fbd9d5", border: "#b42318" },
  // 刻意用真正的藍、不用鳶尾紫：紫色在呼叫歷史圖代表「等下一層」。
  blue: { bg: "#d6e4f7", border: "#2f6db5" },
};

/** 沒寫顏色（'default'）= 動畫焦點：淡黃底＋深金框。細框線不用亮黃（白底上只有 1.7:1），見 gdbgui.css 的 :root。 */
const DEFAULT_PAINT = { bg: "var(--highlight-soft)", border: "var(--highlight-strong)" };

export function highlightStyle(name: string): HighlightPaint {
  if (name === "default") return { name, ...DEFAULT_PAINT, known: true };
  const hit = HIGHLIGHT_TABLE[String(name).trim().toLowerCase()];
  return hit ? { name, ...hit, known: true } : { name, bg: name, border: name, known: false };
}
