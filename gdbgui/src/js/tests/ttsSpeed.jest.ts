import { TTS_BASE_RATE, effectiveTtsRate } from "../ttsSpeed";

test("預設（沒有值）的實際倍率是基礎倍率，使用者看到的仍是 1.0x", () => {
  expect(TTS_BASE_RATE).toBe(1.5);
  expect(effectiveTtsRate(undefined)).toBe(1.5);
  expect(effectiveTtsRate(null)).toBe(1.5);
  expect(effectiveTtsRate(1.0)).toBe(1.5);
});

test("使用者調整的速度照比例乘上基礎倍率", () => {
  expect(effectiveTtsRate(0.5)).toBeCloseTo(0.75);
  expect(effectiveTtsRate(2.0)).toBeCloseTo(3.0);
});
