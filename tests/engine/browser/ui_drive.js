// M1 層 B 驗收 B 的 UI 驅動腳本（在 App 頁面內執行）：匯入教案 → 關閉自動播放 → Run → 單步，
// 每一步記下「停駐行、區域變數、資料結構視覺化面板的文字」，兩個引擎跑同一份再比對。
// 用法（頁面內）：載入本檔後 `await __ui.setup(lessonUrl)`、`await __ui.run()`、`await __ui.steps(n)`、`__ui.out()`。
window.__ui = (() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const panelText = () => {
    // 資料結構視覺化面板：取 body 文字中「資料結構視覺化」到「UML 物件圖」之間（cost／dp／nxt 的格子文字）
    const t = document.body.innerText, i = t.indexOf("資料結構視覺化"), j = t.indexOf("UML 物件圖");
    return i < 0 ? "" : t.slice(i, j > i ? j : i + 900);
  };
  const snap = () => ({
    line: store.get("line_of_source_to_flash"),
    st: store.get("inferior_program"),
    sub: JSON.stringify(store.get("for_sub_step")),
    addr: ((store.get("stack") || [])[0] || {}).addr,
    minA: JSON.stringify(Object.fromEntries(Object.entries((window.gdbgui_global_variable || {}).__for_line_min_addr || {}).map(([k, v]) => [k, String(v)]))),
    locals: (store.get("locals") || []).map((l) => l.name + "=" + String(l.value).slice(0, 60)).join("; "),
    panel: panelText().replace(/\s+/g, " ").trim().slice(0, 700),
    consoleTail: ((document.querySelector("#gdb_console_body, .console-body") || {}).innerText || "").slice(-120),
  });
  const S = { snaps: [], log: [] };
  return {
    engine: () => (window.__vgdbEngine ? "wasm-modules-loaded" : "no-engine-modules") + " / localStorage=" + localStorage.getItem("vgdb_engine") + " / search=" + location.search,
    async setup(url) {
      const txt = await (await fetch(url)).text();
      const f = new File([txt], "lesson.gdbgui.json", { type: "application/json" });
      const dt = new DataTransfer(); dt.items.add(f);
      const inp = document.querySelector("input[type=file]"); inp.files = dt.files; inp.dispatchEvent(new Event("change", { bubbles: true }));
      await sleep(2500);
      const auto = document.getElementById("autoplay_button");
      if (auto && store.get("autoplay_enabled")) auto.click(); // 單步比對不要自動播放（TTS 節奏會干擾）
      return "setup ok";
    },
    async run(waitMs = 15000) {
      document.getElementById("run_button").click();
      const t = Date.now();
      while (Date.now() - t < waitMs && store.get("line_of_source_to_flash") == null) await sleep(200);
      await sleep(1500);
      S.snaps = [snap()];
      return JSON.stringify(S.snaps[0]);
    },
    async steps(n, btn = "next_button") {
      for (let i = 0; i < n; i++) {
        const before = store.get("line_of_source_to_flash"), gen = window.gdbgui_global_variable && window.gdbgui_global_variable.__run_generation;
        document.getElementById(btn).click();
        const t = Date.now();
        await sleep(700);
        while (Date.now() - t < 4000 && store.get("line_of_source_to_flash") === before && store.get("inferior_program") !== "paused") await sleep(100);
        await sleep(700);
        S.snaps.push(snap());
      }
      return S.snaps.length;
    },
    async final(ms = 4000) { await sleep(ms); S.final = snap(); return S.final.line; },
    finalSnap: () => S.final,
    out: () => JSON.stringify(S.snaps.map((s) => s.line + ":" + s.st)),
    subs: () => JSON.stringify(S.snaps.map((s) => s.line + "|" + s.sub + "|" + s.addr)),
    snaps: () => S.snaps,
    dump: (from = 0, to = 1e9) => JSON.stringify(S.snaps.slice(from, to).map((s) => [s.line, s.locals, s.panel])),
  };
})();
