// 前景自動播放驗收：只在網址帶 ?auto=1 時動作（經 proxy.mjs 注入）。
// 流程：匯入技巧一 → 繼續草稿 → 開自動播放 → Run → 每秒取樣，狀態變化就回報 → 程式結束或逾時後回報最後畫面。
(async () => {
  const q = new URLSearchParams(location.search);
  if (!q.get("auto") || !/\/edit$/.test(location.pathname)) return;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const post = (o) => fetch("/__drive/save", { method: "POST", body: JSON.stringify({ engine: q.get("engine") || "gdb", tag: q.get("tag") || "", ...o }) }).catch(() => {});
  const tail = (s, n) => String(s || "").slice(-n);
  try {
    await sleep(3000);
    const txt = await (await fetch("/__drive/lesson.json")).text();
    const f = new File([txt], "lesson.gdbgui.json", { type: "application/json" });
    const dt = new DataTransfer(); dt.items.add(f);
    const inp = document.querySelector("input[type=file]"); inp.files = dt.files; inp.dispatchEvent(new Event("change", { bubbles: true }));
    await sleep(2500);
    const b = [...document.querySelectorAll("button")].find((x) => /繼續編輯這份草稿/.test(x.textContent)); if (b) b.click();
    await sleep(800);
    const manual = q.get("mode") === "manual";
    if (manual ? store.get("autoplay_enabled") : !store.get("autoplay_enabled")) document.getElementById("autoplay_button").click();
    // 事件層級記錄：攔截 store.set，記下每一次「停駐行」與「for 虛步狀態」的寫入（不受取樣頻率影響）
    const ev = [];
    const origSet = store.set;
    store.set = function (k, v) {
      if (k === "line_of_source_to_flash" && v !== undefined) ev.push("L" + v);
      else if (k === "for_sub_step") ev.push(v ? "S" + v.seg : "S-");
      else if (k === "inferior_program" && v === "exited") ev.push("EXIT");
      return origSet.apply(this, arguments);
    };
    await post({ ev: "start", vis: document.visibilityState, ua: navigator.userAgent.slice(0, 60) });
    const attrHist = () => { const h = {}; for (const el of document.querySelectorAll("*")) for (const at of el.attributes) if (at.name.startsWith("data-")) h[at.name] = (h[at.name] || 0) + 1; return h; };
    const panelNow = () => { const t = document.body.innerText, i = t.indexOf("資料結構視覺化"), j = t.indexOf("UML 物件圖"); return i < 0 ? "" : t.slice(i, j > i ? j : i + 900).replace(/\s+/g, " ").replace(/查看 Terminal.*$/, "").trim(); };
    const t0 = Date.now();
    if (manual) {
      // 手動模式：不自動播放。Run → continue 到斷點(31) → next 若干步；每步等「畫面穩定」（面板文字連續 1.2 s 不變，最久 8 s）再取快照。
      const panelStable = async () => { let last = panelNow(), st = 0, w0 = Date.now(); while (st < 1200 && Date.now() - w0 < 8000) { await sleep(200); const c = panelNow(); if (c === last) st += 200; else { st = 0; last = c; } } return last; };
      const attrs = () => { const h = attrHist(); return h; };
      document.getElementById("run_button").click();
      const w0 = Date.now(); while (Date.now() - w0 < 40000 && store.get("inferior_program") !== "paused") await sleep(300);
      await sleep(1500);
      const N = Number(q.get("steps") || 70);
      for (let i = -1; i < N; i++) {
        if (i === -1) document.getElementById("continue_button").click(); else document.getElementById("next_button").click();
        const t1 = Date.now(); await sleep(900);
        while (Date.now() - t1 < 8000 && store.get("inferior_program") !== "paused") await sleep(150);
        const panel = await panelStable();
        await post({ ev: "mstep", i, line: store.get("line_of_source_to_flash"), sub: JSON.stringify(store.get("for_sub_step")), locals: (store.get("locals") || []).map((l) => l.name + ":" + String(l.value).slice(0, 40)).join(" | "), panel: panel.slice(0, 600), attrs: attrs() });
      }
      await post({ ev: "end", t: Date.now() - t0, vis: document.visibilityState, events: ev.join(" "), seq: "", panel: "", terminalTail: "" });
      return;
    }
    document.getElementById("run_button").click();
    // 導引行停駐時的畫面快照：面板文字＋data-* 屬性統計（e2e 契約屬性），兩個引擎逐「行×第幾次到訪」比對
    const KEY = new Set([34, 44, 48, 53, 57]), visit = {};
    let lastKeyLine = null;
    let prev = "", exitedAt = 0;
    const seq = [];
    while (Date.now() - t0 < 12 * 60 * 1000) {
      await sleep(1000);
      const line = store.get("line_of_source_to_flash"), st = store.get("inferior_program"), sub = JSON.stringify(store.get("for_sub_step"));
      const k = line + "|" + st + "|" + sub;
      if (k !== prev) { prev = k; seq.push(line + "/" + st); await post({ ev: "state", t: Date.now() - t0, line, st, sub }); }
      if (st === "paused" && KEY.has(Number(line)) && line !== lastKeyLine) {
        lastKeyLine = line; visit[line] = (visit[line] || 0) + 1; const v = visit[line], ln = line;
        setTimeout(() => post({ ev: "snap", line: ln, visit: v, panel: panelNow().slice(0, 500), attrs: attrHist() }), 1800);
      } else if (!KEY.has(Number(line))) lastKeyLine = null;
      if (st === "exited") { if (!exitedAt) exitedAt = Date.now(); if (Date.now() - exitedAt > 4000) break; } else exitedAt = 0;
    }
    const body = document.body.innerText;
    const i = body.indexOf("資料結構視覺化"), j = body.indexOf("UML 物件圖");
    await post({ ev: "end", t: Date.now() - t0, vis: document.visibilityState, seqLen: seq.length, events: ev.join(" "), seq: seq.join(" "), panel: i < 0 ? "" : body.slice(i, j > i ? j : i + 900).replace(/\s+/g, " "), terminalTail: tail(body, 400).replace(/\s+/g, " ") });
  } catch (e) { await post({ ev: "error", msg: String(e && e.stack || e).slice(0, 400) }); }
})();
