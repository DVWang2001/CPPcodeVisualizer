/**
 * 右側欄方案 D 的高度分配（純函式，不碰 DOM）。
 *
 * 每個面板高度 = 標題列（收合）或 最小高度（展開，含標題列）＋ 剩餘空間依權重分配。
 * 權重存的是「超出最小高度的像素數」，所以拖曳分隔條後直接把新高度寫回權重即可，
 * 不必另外換算；視窗高度變動時，展開面板的比例會跟著縮放。
 */

export interface SidebarPanel {
  id: string;
  open: boolean;
  /** 展開面板超出最小高度的像素數；收合面板忽略此值。 */
  weight: number;
}

export interface SidebarSizing {
  /** 欄位可用總高度（.sidebar-collapsers 的高度）。 */
  total_px: number;
  /** 收合面板（只剩標題列）的高度。 */
  header_px: number;
  /** 展開面板的最小高度（含標題列）。 */
  min_open_px: number;
}

export interface SidebarLayout {
  /** 每個面板的像素高度，key 為面板 id。 */
  heights: Record<string, number>;
  /** 空間不足而被自動收合的面板 id（依被收合的順序，從最後一個開始）。 */
  dropped: string[];
}

/** 把展開面板的可用空間依權重分配；權重全為 0 時平分。 */
function distribute(ids: string[], panels: SidebarPanel[], sizing: SidebarSizing, extra_px: number): Record<string, number> {
  const heights: Record<string, number> = {};
  if (ids.length === 0) return heights;
  const weight_of = (id: string) => Math.max(0, panels.find(p => p.id === id)!.weight);
  const sum = ids.reduce((s, id) => s + weight_of(id), 0);
  let used = 0;
  ids.forEach((id, i) => {
    const share = sum > 0 ? weight_of(id) / sum : 1 / ids.length;
    // 最後一個吃掉捨入誤差，確保總和精確等於欄位高度。
    const extra = i === ids.length - 1 ? extra_px - used : Math.floor(extra_px * share);
    used += extra;
    heights[id] = sizing.min_open_px + extra;
  });
  return heights;
}

export function layoutSidebar(panels: SidebarPanel[], sizing: SidebarSizing): SidebarLayout {
  const { total_px, header_px, min_open_px } = sizing;
  const keep = panels.filter(p => p.open).map(p => p.id);
  const dropped: string[] = [];

  // 空間不夠容納所有展開面板的最小高度時，從最後一個展開的面板開始收合。
  const closed_count = () => panels.length - keep.length;
  while (keep.length > 0 && closed_count() * header_px + keep.length * min_open_px > total_px) {
    dropped.push(keep.pop()!);
  }

  const extra_px = total_px - closed_count() * header_px - keep.length * min_open_px;
  const heights: Record<string, number> = {};
  for (const p of panels) {
    if (!keep.includes(p.id)) heights[p.id] = header_px;
  }
  Object.assign(heights, distribute(keep, panels, sizing, Math.max(0, extra_px)));
  return { heights, dropped };
}

/**
 * 拖曳 panels[index] 與 panels[index + 1] 之間的分隔條，移動 delta_px（正數向下）。
 * 上方要是展開的，下方取第一個展開的面板；找不到或被自動收合就原樣回傳。回傳的面板權重已依新高度寫回。
 */
export function dragDivider(panels: SidebarPanel[], sizing: SidebarSizing, index: number, delta_px: number): SidebarPanel[] {
  const upper = panels[index];
  if (!upper || !upper.open) return panels;
  // 下方第一個展開的面板：中間收合的面板只剩標題列，高度不動，所以跨過去拿下一個展開的。
  const lower_index = panels.findIndex((p, i) => i > index && p.open);
  if (lower_index < 0) return panels;
  const lower = panels[lower_index];

  const { heights: before, dropped } = layoutSidebar(panels, sizing);
  // 因空間不足被自動收合的面板不能拖（它現在只有標題列）。
  if (dropped.includes(upper.id) || dropped.includes(lower.id)) return panels;
  // 上方最多縮到最小高度，下方同理；delta 夾在兩者之間。
  const max_up = before[upper.id] - sizing.min_open_px;
  const max_down = before[lower.id] - sizing.min_open_px;
  const delta = Math.max(-max_up, Math.min(max_down, delta_px));

  const next_height = { ...before, [upper.id]: before[upper.id] + delta, [lower.id]: before[lower.id] - delta };
  return panels.map(p => (p.open ? { ...p, weight: next_height[p.id] - sizing.min_open_px } : p));
}
