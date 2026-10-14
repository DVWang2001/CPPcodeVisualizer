// TTS 音量：0 ~ 6 倍。瀏覽器 audio.volume 最大只有 1，要放大到 1 以上必須走 Web Audio 的 GainNode，
// 所以只有音量 > 1 才改道；≤ 1 時直接用 audio.volume，保持原本最單純的播放路徑。
export const TTS_MAX_VOLUME = 6;
export const TTS_DEFAULT_VOLUME = 2; // 原本 1.0 太小聲，預設放大 2 倍
const KEY = "gdbgui_tts_volume";

function clamp(v: number): number {
  return isNaN(v) ? TTS_DEFAULT_VOLUME : Math.min(TTS_MAX_VOLUME, Math.max(0, v));
}

export function loadTtsVolume(): number {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw !== null) return clamp(parseFloat(raw));
  } catch (_) {}
  return TTS_DEFAULT_VOLUME;
}

let volume = loadTtsVolume();
let ctx: AudioContext | null = null;
const gains = new WeakMap<HTMLAudioElement, GainNode>();

export function getTtsVolume(): number {
  return volume;
}

/** 把目前音量套到這個 audio 元素；idempotent，每次播放前與拖曳滑桿時都可呼叫。 */
export function applyTtsVolume(audio: HTMLAudioElement | null | undefined): void {
  if (!audio) return;
  let g = gains.get(audio);
  if (!g && volume > 1) {
    try {
      const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
      ctx = ctx || new AC();
      if (ctx!.state === "suspended") ctx!.resume();
      const src = ctx!.createMediaElementSource(audio);
      g = ctx!.createGain();
      src.connect(g);
      g.connect(ctx!.destination);
      gains.set(audio, g);
    } catch (_) {}
  }
  if (g) {
    g.gain.value = volume;
    audio.volume = 1;
  } else {
    audio.volume = Math.min(volume, 1);
  }
}

export function setTtsVolume(v: number): number {
  volume = clamp(v);
  try { localStorage.setItem(KEY, String(volume)); } catch (_) {}
  applyTtsVolume((window as any)._tts_api?._current?.());
  return volume;
}
