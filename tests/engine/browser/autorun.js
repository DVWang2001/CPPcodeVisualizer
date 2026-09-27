// 前景自動播放驗收：只在網址帶 ?auto=1 時動作（經 proxy.mjs 注入）。
// 流程：匯入技巧一 → 繼續草稿 → 開自動播放 → Run → 每秒取樣，狀態變化就回報 → 程式結束或逾時後回報最後畫面。
(async () => {
  const q = new URLSearchParams(location.search);
  // 獨立 Chrome 執行個體（無登入狀態）：在 /login 用本機測試帳號登入（帳密由代理從環境變數指定的檔案提供，不在 repo），
  // 登入後導回 vgnext 指定的頁面。
  if (location.pathname === "/login") {
    if (q.get("vgnext")) sessionStorage.setItem("vg_next", q.get("vgnext"));
    const cred = Object.fromEntries((await (await fetch("/__drive/cred")).text()).split(String.fromCharCode(10)).filter(Boolean).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; }));
    if (!cred.username) return;
    await new Promise((r) => setTimeout(r, 800));
    document.getElementById("username").value = cred.username; document.getElementById("password").value = cred.password;
    document.getElementById("submit").click(); return;
  }
  if (sessionStorage.getItem("vg_next") && !q.get("auto")) { const n = sessionStorage.getItem("vg_next"); sessionStorage.removeItem("vg_next"); location.replace(n); return; }
  if (!q.get("auto") || !/\/edit$/.test(location.pathname)) return;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const batch = q.get("batch") === "1", idx = Number(q.get("idx") || 0);
  const post = (o) => fetch("/__drive/save", { method: "POST", body: JSON.stringify({ engine: q.get("engine") || "gdb", tag: q.get("tag") || "", ...(batch ? { idx } : {}), ...o }) }).catch(() => {});
  const tail = (s, n) => String(s || "").slice(-n);
  try {
    await sleep(3000);
    window.alert = () => {}; window.confirm = () => true; window.prompt = () => null; // JS 對話框會凍結整個頁面
    // 決定性的亂數：內建隨機測資（🎲、教案 @random）用 Math.random，固定種子才能讓兩個引擎拿到同一份輸入
    { let t = Number(q.get("seed") || 12345) >>> 0; Math.random = () => { t += 0x6D2B79F5; let r = Math.imul(t ^ (t >>> 15), 1 | t); r ^= r + Math.imul(r ^ (r >>> 7), 61 | r); return ((r ^ (r >>> 14)) >>> 0) / 4294967296; }; }
    // 每份教案的看門狗：超過上限就記錄後換下一份（頁面若被別的東西卡住，這個 interval 仍會跑）
    const LIMIT = (q.get("mode") === "manual" ? 4 : 5) * 60 * 1000, wd0 = Date.now();
    const wd = setInterval(async () => {
      if (Date.now() - wd0 < LIMIT) return;
      clearInterval(wd);
      await post({ ev: "end", lesson: batch ? "?" : "tsp", watchdog: true, exited: false, timedOut: true, t: Date.now() - wd0, terminalTail: "" });
      if (batch && q.get("only") !== "1") { const u = new URL(location.href); u.searchParams.delete("retry"); u.searchParams.set("idx", String(idx + 1)); location.replace(u.toString()); }
    }, 5000);
    // 先丟棄前一份教案留下的本機草稿（否則「繼續編輯草稿」會蓋掉剛匯入的教案）
    { const d = [...document.querySelectorAll("button")].find((x) => /捨棄，用空白範本/.test(x.textContent)); if (d) { d.click(); await sleep(800); } }
    const lessons = batch ? await (await fetch("/__drive/lessons.json")).json() : [];
    if (batch && idx >= lessons.length) { await post({ ev: "batchdone", total: lessons.length }); return; }
    const lessonName = batch ? lessons[idx].name : "tsp";
    const txt = await (await fetch(batch ? "/__drive/lesson/" + idx + ".json" : "/__drive/lesson.json")).text();
    let hasBp = true; try { hasBp = (JSON.parse(txt).breakpoints || []).length > 0; } catch (e) { /* keep default */ }
    const f = new File([txt], "lesson.gdbgui.json", { type: "application/json" });
    const dt = new DataTransfer(); dt.items.add(f);
    const inp = document.querySelector("input[type=file]"); inp.files = dt.files; inp.dispatchEvent(new Event("change", { bubbles: true }));
    await sleep(2500);
    const b = batch ? null : [...document.querySelectorAll("button")].find((x) => /繼續編輯這份草稿/.test(x.textContent)); if (b) b.click();
    await sleep(800);
    const manual = q.get("mode") === "manual" || q.get("mode") === "rerun";
    const rerun = q.get("mode") === "rerun";
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
    // 固定輸入：?input= 直接覆寫（兩個引擎餵同一份），並在 start 事件記下實際使用的輸入供事後對照
    if (q.get("input") !== null && q.get("input") !== undefined && q.get("input") !== "") { const v = q.get("input"); store.set("program_input", v); try { localStorage.setItem("gdbgui_program_input", v); } catch (e) { /* ignore */ } }
    const usedInput = String(store.get("program_input") || localStorage.getItem("gdbgui_program_input") || "");
    await post({ ev: "start", lesson: lessonName, input: usedInput, vis: document.visibilityState, ua: navigator.userAgent.slice(0, 60) });
    const attrHist = () => { const h = {}; for (const el of document.querySelectorAll("*")) for (const at of el.attributes) if (at.name.startsWith("data-")) h[at.name] = (h[at.name] || 0) + 1; return h; };
    const panelNow = () => { const t = document.body.innerText, i = t.indexOf("資料結構視覺化"), j = t.indexOf("UML 物件圖"); return i < 0 ? "" : t.slice(i, j > i ? j : i + 900).replace(/\s+/g, " ").replace(/查看 Terminal.*$/, "").trim(); };
    const t0 = Date.now();
    if (manual) {
      // 手動模式：不自動播放。Run → continue（到第一個斷點或結束）→ next 若干步；每步等「畫面穩定」再取快照；
      // 最後 continue 跑到程式結束，記錄終端機輸出。批次時自動換下一份教案。
      const panelStable = async () => { let last = panelNow(), st = 0, w0 = Date.now(); while (st < 900 && Date.now() - w0 < 5000) { await sleep(150); const c = panelNow(); if (c === last) st += 150; else { st = 0; last = c; } } return last; };
      const stepBtn = async (id) => {
        document.getElementById(id).click();
        const t1 = Date.now(); await sleep(700);
        while (Date.now() - t1 < 8000 && store.get("inferior_program") !== "paused" && store.get("inferior_program") !== "exited") await sleep(150);
      };
      document.getElementById("run_button").click();
      const w0 = Date.now(); while (Date.now() - w0 < 90000 && store.get("inferior_program") !== "paused") await sleep(300); // 只等 paused：頁面載入時的初始狀態就是 exited，不能當作「Run 完成」
      if (store.get("inferior_program") !== "paused") { await post({ ev: "end", lesson: lessonName, started: store.get("inferior_program"), exited: false, neverPaused: true, t: Date.now() - t0, terminalTail: "" }); if (batch && q.get("only") !== "1") { const u = new URL(location.href); u.searchParams.delete("retry"); u.searchParams.set("idx", String(idx + 1)); location.replace(u.toString()); } return; }
      await sleep(1500);
      const N = Number(q.get("steps") || 30);
      let started = store.get("inferior_program");
      if (rerun) {
        // 換測資重跑（快速題／隨機測資會做的事）：先走 3 步 → 用固定種子按 🎲 換一組輸入 → 再按 Run（引擎 session 要能被取代）→ 走 5 步 → continue 到結束
        const reseed = (seed) => { let t = seed >>> 0; Math.random = () => { t += 0x6D2B79F5; let r = Math.imul(t ^ (t >>> 15), 1 | t); r ^= r + Math.imul(r ^ (r >>> 7), 61 | r); return ((r ^ (r >>> 14)) >>> 0) / 4294967296; }; };
        for (let i = 0; i < 3; i++) { await stepBtn("next_button"); }
        const dice = [...document.querySelectorAll("button")].find((x) => /隨機測資/.test(x.textContent) || /換一組隨機測資/.test(x.title));
        reseed(777);
        if (dice) dice.click();
        await sleep(800);
        const newInput = String(store.get("program_input") || localStorage.getItem("gdbgui_program_input") || "");
        await post({ ev: "rerun-input", lesson: lessonName, hasDice: !!dice, input: newInput.slice(0, 300), lines: (JSON.stringify(store.get("line_of_source_to_flash"))) });
        window.gdbgui_rerunning_for_quiz = false;
        document.getElementById("run_button").click();
        const w1 = Date.now(); await sleep(1500); while (Date.now() - w1 < 90000 && store.get("inferior_program") !== "paused") await sleep(300);
        await sleep(1500);
        for (let i = -1; i < 5 && store.get("inferior_program") === "paused"; i++) {
          await stepBtn(i === -1 && hasBp ? "continue_button" : "next_button");
          await post({ ev: "mstep", lesson: lessonName, i: 100 + i, line: store.get("line_of_source_to_flash"), st: store.get("inferior_program"), sub: JSON.stringify(store.get("for_sub_step")), locals: (store.get("locals") || []).map((l) => l.name + ":" + String(l.value).slice(0, 40)).join(" | "), panel: (await panelStable()).slice(0, 500), attrs: attrHist() });
        }
        let g2 = 0; while (store.get("inferior_program") !== "exited" && g2++ < 60) await stepBtn("continue_button");
        await sleep(1500);
        await post({ ev: "end", lesson: lessonName, rerun: true, exited: store.get("inferior_program") === "exited", t: Date.now() - t0, terminalTail: document.body.innerText.slice(-400).replace(/\s+/g, " ") });
        return;
      }
      for (let i = hasBp ? -1 : 0; i < N && store.get("inferior_program") !== "exited"; i++) {
        await stepBtn(i === -1 ? "continue_button" : "next_button");
        const panel = await panelStable();
        await post({ ev: "mstep", lesson: lessonName, i, line: store.get("line_of_source_to_flash"), st: store.get("inferior_program"), sub: JSON.stringify(store.get("for_sub_step")), locals: (store.get("locals") || []).map((l) => l.name + ":" + String(l.value).slice(0, 40)).join(" | "), panel: panel.slice(0, 500), attrs: attrHist() });
      }
      let guard = 0; while (store.get("inferior_program") !== "exited" && guard++ < 40) await stepBtn("continue_button");
      await sleep(1500);
      await post({ ev: "end", lesson: lessonName, started, exited: store.get("inferior_program") === "exited", t: Date.now() - t0, vis: document.visibilityState, terminalTail: document.body.innerText.slice(-500).replace(/\s+/g, " ") });
      if (batch && q.get("only") !== "1") { const u = new URL(location.href); u.searchParams.delete("retry"); u.searchParams.set("idx", String(idx + 1)); await sleep(1500); location.replace(u.toString()); }
      return;
    }
    document.getElementById("run_button").click();
    // 導引行停駐時的畫面快照：面板文字＋data-* 屬性統計（e2e 契約屬性），兩個引擎逐「行×第幾次到訪」比對
    const KEY = new Set([34, 44, 48, 53, 57]), visit = {};
    let lastKeyLine = null;
    let prev = "", exitedAt = 0;
    const seq = [];
    let lastChange = Date.now(), stalled = false;
    while (Date.now() - t0 < (batch ? 5 * 60 * 1000 : 12 * 60 * 1000)) {
      await sleep(1000);
      const line = store.get("line_of_source_to_flash"), st = store.get("inferior_program"), sub = JSON.stringify(store.get("for_sub_step"));
      const k = line + "|" + st + "|" + sub;
      if (k !== prev) { prev = k; lastChange = Date.now(); seq.push(line + "/" + st); await post({ ev: "state", t: Date.now() - t0, line, st, sub }); }
      if (st === "paused" && KEY.has(Number(line)) && line !== lastKeyLine) {
        lastKeyLine = line; visit[line] = (visit[line] || 0) + 1; const v = visit[line], ln = line;
        setTimeout(() => post({ ev: "snap", line: ln, visit: v, panel: panelNow().slice(0, 500), attrs: attrHist() }), 1800);
      } else if (!KEY.has(Number(line))) lastKeyLine = null;
      if (batch && Date.now() - lastChange > 90000) { stalled = true; break; }
      if (st === "exited") { if (!exitedAt) exitedAt = Date.now(); if (Date.now() - exitedAt > 4000) break; } else exitedAt = 0;
    }
    if (batch && stalled && seq.length <= 1 && !q.get("retry")) {
      // 一個狀態都沒有＝這次 Run 根本沒啟動（頁面剛載入後的競態），同一份教案重載重試一次
      await post({ ev: "retry", lesson: lessonName });
      const u0 = new URL(location.href); u0.searchParams.set("retry", "1"); await sleep(1000); location.replace(u0.toString()); return;
    }
    const body = document.body.innerText;
    const i = body.indexOf("資料結構視覺化"), j = body.indexOf("UML 物件圖");
    await post({ ev: "end", lesson: lessonName, stalled, timedOut: !stalled && !exitedAt, t: Date.now() - t0, vis: document.visibilityState, seqLen: seq.length, events: ev.join(" "), seq: seq.join(" "), panel: i < 0 ? "" : body.slice(i, j > i ? j : i + 900).replace(/\s+/g, " "), terminalTail: tail(body, 400).replace(/\s+/g, " ") });
    if (batch && q.get("only") !== "1") { const u = new URL(location.href); u.searchParams.delete("retry"); u.searchParams.set("idx", String(idx + 1)); await sleep(1500); location.replace(u.toString()); }
  } catch (e) {
    await post({ ev: "error", msg: String(e && e.stack || e).slice(0, 400) });
    if (batch) { const u = new URL(location.href); u.searchParams.set("idx", String(idx + 1)); setTimeout(() => location.replace(u.toString()), 2000); }
  }
})();
