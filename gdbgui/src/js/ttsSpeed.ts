// TTS 的實際播放倍率 = 使用者看到的速度 × 基礎倍率。
//
// 使用者介面（速度滑桿、[speed:N] 標記、預設 1.0x）一律以「1.0x = 正常」呈現；
// 但語音合成出來的原速對課堂來說太慢，所以實際播放時再乘上基礎倍率。
// 想整體調快或調慢，只改這一個數字，畫面上顯示的數值與教案裡寫的 [speed:N] 都不必動。
export const TTS_BASE_RATE = 1.5;

/** 把使用者看到的速度（沒有值就當 1.0）換成要設給 audio.playbackRate 的數字。 */
export function effectiveTtsRate(userSpeed?: number | null): number {
  return (userSpeed || 1.0) * TTS_BASE_RATE;
}
