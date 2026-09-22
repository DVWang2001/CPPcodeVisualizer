// ── TTS 播放清單的純解析邏輯 ──────────────────────────────────────────────
// 把 play_tts 已經展開完 {expr}、拿掉自動播放指令前綴的最終文字
// （VisualizerHelper.js 裡的 evaluateSpokenText）切成一份播放清單：
// 語音段落（送去 TTS 合成）、停頓（[wait:N]/[pause:N]）、動畫觸發點
// （[anim]——播到這裡才觸發被延後的 pop:/pull:，見 SourceCode.tsx 的
// applyLayout/hasAnimMarker）。純字串轉換，不碰 Audio/fetch，方便測試；
// 實際播放清單的消耗（依序播音檔、等待、呼叫觸發器）留在
// VisualizerHelper.js 的 _tts_play_next。

export type TtsPlaylistItem =
  | { type: "audio"; text: string; url: string; currentTime: number }
  | { type: "wait"; duration: number }
  | { type: "anim" };

const MARKER_RE = /\[(?:wait|pause):([\d.]+)\]|\[anim\]/g;
const PRONOUNCE_RE = /([^[\]]+)\[([^[\]]+)\]/g;

function toAudioItem(segText: string): TtsPlaylistItem | null {
  // 處理自定義發音 "字[音]"：替換讀音（白[柏] → 柏），讓 TTS 讀對。
  const spokenSegText = segText
    .replace(PRONOUNCE_RE, (_match, prefix, pronunciation) => prefix.slice(0, -1) + pronunciation)
    .replace(/⟦/g, "[")
    .replace(/⟧/g, "]");
  if (!spokenSegText.trim()) return null;
  const url = `/tts_audio?text=${encodeURIComponent(spokenSegText.trim())}`;
  return { type: "audio", text: spokenSegText.trim(), url, currentTime: 0 };
}

export function parseTtsPlaylist(evaluateSpokenText: string): TtsPlaylistItem[] {
  const playlist: TtsPlaylistItem[] = [];
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  // 每次呼叫都要用新的 regex 物件（或重置 lastIndex）：帶 g 旗標的 regex 是有
  // 狀態的，重用同一個模組層級物件在多次呼叫間會從上次結束的位置繼續找，
  // 而不是從頭開始。
  const markerRegex = new RegExp(MARKER_RE.source, MARKER_RE.flags);
  while ((m = markerRegex.exec(evaluateSpokenText)) !== null) {
    const audioItem = toAudioItem(evaluateSpokenText.slice(lastIndex, m.index));
    if (audioItem) playlist.push(audioItem);
    if (m[1] !== undefined) {
      const duration = parseFloat(m[1]);
      if (!isNaN(duration) && duration > 0) {
        playlist.push({ type: "wait", duration });
      }
    } else {
      playlist.push({ type: "anim" });
    }
    lastIndex = markerRegex.lastIndex;
  }
  const tailItem = toAudioItem(evaluateSpokenText.slice(lastIndex));
  if (tailItem) playlist.push(tailItem);
  return playlist;
}
