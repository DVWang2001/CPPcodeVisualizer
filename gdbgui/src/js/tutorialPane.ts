/** 教學頁左欄（文件）的收合：把它的寬度讓給中間的編輯器，展開時還原成收合前的比例。 */
export function collapseSizes(sizes: number[]): number[] {
  return [0, sizes[0] + sizes[1], sizes[2]];
}

export function isCollapsed(sizes: number[]): boolean {
  return sizes[0] < 1;
}
