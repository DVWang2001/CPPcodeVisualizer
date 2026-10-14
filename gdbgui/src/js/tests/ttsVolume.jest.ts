import { setTtsVolume, getTtsVolume, applyTtsVolume, TTS_MAX_VOLUME } from "../ttsVolume";

describe("ttsVolume", () => {
  test("音量夾在 0 ~ 6 之間", () => {
    expect(setTtsVolume(99)).toBe(TTS_MAX_VOLUME);
    expect(setTtsVolume(-1)).toBe(0);
    expect(getTtsVolume()).toBe(0);
  });
  test("≤ 1 直接用 audio.volume，不走 Web Audio", () => {
    setTtsVolume(0.5);
    const a: any = { volume: 1 };
    applyTtsVolume(a);
    expect(a.volume).toBe(0.5);
  });
  test("> 1 時走 GainNode，audio.volume 固定 1", () => {
    const gain = { gain: { value: 0 }, connect: jest.fn() };
    (window as any).AudioContext = jest.fn(() => ({
      state: "running", destination: {},
      createMediaElementSource: () => ({ connect: jest.fn() }),
      createGain: () => gain,
    }));
    setTtsVolume(4);
    const a: any = { volume: 0.3 };
    applyTtsVolume(a);
    expect(gain.gain.value).toBe(4);
    expect(a.volume).toBe(1);
  });
});
