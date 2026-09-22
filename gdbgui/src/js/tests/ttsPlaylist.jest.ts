import { parseTtsPlaylist } from "../ttsPlaylist";

describe("parseTtsPlaylist", () => {
  test("純文字：只有一個 audio 項目", () => {
    expect(parseTtsPlaylist("先看從上面來的")).toEqual([
      { type: "audio", text: "先看從上面來的", url: "/tts_audio?text=%E5%85%88%E7%9C%8B%E5%BE%9E%E4%B8%8A%E9%9D%A2%E4%BE%86%E7%9A%84", currentTime: 0 },
    ]);
  });

  test("[wait:N] 切出獨立的 wait 項目，前後文字各自成一段", () => {
    expect(parseTtsPlaylist("前段[wait:1.5]後段")).toEqual([
      { type: "audio", text: "前段", url: expect.any(String), currentTime: 0 },
      { type: "wait", duration: 1.5 },
      { type: "audio", text: "後段", url: expect.any(String), currentTime: 0 },
    ]);
  });

  test("[pause:N] 跟 [wait:N] 等價", () => {
    const r = parseTtsPlaylist("甲[pause:0.5]乙");
    expect(r[1]).toEqual({ type: "wait", duration: 0.5 });
  });

  test("[anim]：播到這裡觸發延後動畫的獨立項目，不送進語音合成", () => {
    expect(parseTtsPlaylist("上面{up}左邊{left}[anim]兩邊加起來就是答案")).toEqual([
      { type: "audio", text: "上面{up}左邊{left}", url: expect.any(String), currentTime: 0 },
      { type: "anim" },
      { type: "audio", text: "兩邊加起來就是答案", url: expect.any(String), currentTime: 0 },
    ]);
  });

  test("[anim] 在開頭或結尾都能正確切出來，不會漏掉前後的空段落", () => {
    expect(parseTtsPlaylist("[anim]後段")).toEqual([
      { type: "anim" },
      { type: "audio", text: "後段", url: expect.any(String), currentTime: 0 },
    ]);
    expect(parseTtsPlaylist("前段[anim]")).toEqual([
      { type: "audio", text: "前段", url: expect.any(String), currentTime: 0 },
      { type: "anim" },
    ]);
  });

  test("只有 [anim]，沒有任何語音文字：清單只有一個 anim 項目", () => {
    expect(parseTtsPlaylist("[anim]")).toEqual([{ type: "anim" }]);
  });

  test("多個 [anim]（目前只有第一個會實際觸發延後動畫，見 SourceCode.tsx，但清單本身要如實反映）", () => {
    expect(parseTtsPlaylist("甲[anim]乙[anim]丙")).toEqual([
      { type: "audio", text: "甲", url: expect.any(String), currentTime: 0 },
      { type: "anim" },
      { type: "audio", text: "乙", url: expect.any(String), currentTime: 0 },
      { type: "anim" },
      { type: "audio", text: "丙", url: expect.any(String), currentTime: 0 },
    ]);
  });

  test("[anim] 跟 [wait:N] 混用，順序保留", () => {
    expect(parseTtsPlaylist("甲[wait:1]乙[anim]丙")).toEqual([
      { type: "audio", text: "甲", url: expect.any(String), currentTime: 0 },
      { type: "wait", duration: 1 },
      { type: "audio", text: "乙", url: expect.any(String), currentTime: 0 },
      { type: "anim" },
      { type: "audio", text: "丙", url: expect.any(String), currentTime: 0 },
    ]);
  });

  test("自訂發音 字[音] 不會被誤認成 [anim] 或 [wait:N]", () => {
    const r = parseTtsPlaylist("白[柏]先生[anim]到了");
    expect(r).toEqual([
      { type: "audio", text: "柏先生", url: expect.any(String), currentTime: 0 },
      { type: "anim" },
      { type: "audio", text: "到了", url: expect.any(String), currentTime: 0 },
    ]);
  });

  test("⟦⟧ 轉義的方括號（求值結果本身帶中括號）不會被當成標記", () => {
    // play_tts 在把 {expr} 求值結果塞回字串前，會把值裡的 [ ] 轉成 ⟦ ⟧
    // 避免被這裡的 marker regex 誤吃；parseTtsPlaylist 收到的就是轉義後的形式，
    // 最後要轉回真正的方括號給 TTS 唸。
    const r = parseTtsPlaylist("陣列是 ⟦1, 2, 3⟧[anim]這是結果");
    expect(r[0]).toEqual({ type: "audio", text: "陣列是 [1, 2, 3]", url: expect.any(String), currentTime: 0 });
    expect(r[1]).toEqual({ type: "anim" });
  });

  test("空字串回空陣列", () => {
    expect(parseTtsPlaylist("")).toEqual([]);
  });

  test("[wait:0] 或負數：不成立的停頓不放進清單，但文字仍照原樣切成前後兩段（跟原本行為一致）", () => {
    expect(parseTtsPlaylist("甲[wait:0]乙")).toEqual([
      { type: "audio", text: "甲", url: expect.any(String), currentTime: 0 },
      { type: "audio", text: "乙", url: expect.any(String), currentTime: 0 },
    ]);
  });

  test("連續呼叫兩次都要正確——g 旗標 regex 不能把狀態帶到下一次呼叫", () => {
    // 這是這個實作的一個真實風險：帶 g 的 RegExp 如果被當成模組層級單例重用，
    // lastIndex 會殘留到下一次呼叫，導致從中間開始找、漏掉開頭的 marker。
    const first = parseTtsPlaylist("甲[anim]乙");
    const second = parseTtsPlaylist("丙[anim]丁");
    expect(first).toEqual([
      { type: "audio", text: "甲", url: expect.any(String), currentTime: 0 },
      { type: "anim" },
      { type: "audio", text: "乙", url: expect.any(String), currentTime: 0 },
    ]);
    expect(second).toEqual([
      { type: "audio", text: "丙", url: expect.any(String), currentTime: 0 },
      { type: "anim" },
      { type: "audio", text: "丁", url: expect.any(String), currentTime: 0 },
    ]);
  });
});
