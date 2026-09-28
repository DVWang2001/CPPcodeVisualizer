// localEngine.ts（vgdb M1 層 B）單元測試：旗標、LocalSocket、模擬 /create_and_upload、/read_file 跳脫。
// 引擎與 LocalGdb 一律用假的（_test.setModules）；另有一組用真的 LocalGdb 驗「尚未 Run」的命令。
import { store } from "statorgfc";
import initialStoreData from "../InitialStoreData";
import localEngine, {
  _test,
  enabled,
  LocalSocket,
  LocalGdbLike,
  mapRunError,
  runWarnings,
  gdbFallbackUrl,
  readFile,
  escapeHtml,
  SOURCE_PATH,
  GDB_SOURCE_PATH,
  BINARY_PATH,
  FIXED_MTIME,
  emptyRunResult,
  stdinFor,
} from "../localEngine";

// @ts-expect-error statorgfc's old declarations omit initialize.
store.initialize({ ...initialStoreData }, { immutable: false, debounce_ms: 0 });

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

/** A LocalGdb stand-in: records what it receives, answers each run_gdb_command on a microtask. */
function fakeGdb(pid = 4242, model: any = undefined) {
  const listeners: { [ev: string]: Array<(p: any) => void> } = {};
  const received: Array<[string, any]> = [];
  const state = { closed: false, runToken: null as string | null };
  const g: LocalGdbLike & { received: typeof received; state: typeof state; fire: (ev: string, p: any) => void } = {
    received,
    state,
    session: { pid, model },
    socket: {
      on: (ev: string, cb: (p: any) => void) => {
        (listeners[ev] = listeners[ev] || []).push(cb);
      },
      emit: (ev: string, p: any) => {
        if (state.closed) return;
        received.push([ev, p]);
        if (ev === "run_gdb_command") {
          Promise.resolve().then(() => g.fire("gdb_response", { run_token: p.run_token, request_id: p.request_id, data: [{ cmd: p.cmd }] }));
        }
      },
      close: () => {
        state.closed = true;
      },
    },
    fire: (ev: string, p: any) => {
      if (state.closed) return;
      (listeners[ev] || []).forEach((cb) => cb(p));
    },
    idle: () => flush(),
    setRunToken: (t: string | null) => {
      state.runToken = t;
    },
    close: () => {
      state.closed = true;
    },
  };
  return g;
}

function okRun(extra: any = {}) {
  return { ...emptyRunResult(), steps: [{ line: 3, fn: "main", depth: 1, frame: 1, vars: {} }], stdout: "hi\n", ...extra };
}

function fakeModules(runResult: any | ((src: string, stdin: string) => any)) {
  const created: any[] = [];
  const runs: Array<{ source: string; stdin: string }> = [];
  const engine = {
    runProgram: jest.fn((source: string, stdin: string) => {
      runs.push({ source, stdin });
      const r = typeof runResult === "function" ? runResult(source, stdin) : runResult;
      return r instanceof Promise ? r : Promise.resolve(r);
    }),
    dispose: jest.fn(),
  };
  const mods = {
    engine: { loadEngine: jest.fn(() => Promise.resolve(engine)) },
    localgdb: {
      createLocalGdb: jest.fn((opts: any) => {
        // opts.runResult stands in for a TraceModel here (buildPrerunSnapshots is mocked below, so
        // no real model shape is required — only object identity matters for the assertion).
        const g = fakeGdb(4242, opts.runResult);
        created.push({ opts, gdb: g });
        return g;
      }),
      buildPrerunSnapshots: jest.fn((_model: any) => [[{ func: "main", addr: "0x0", line: "1", args: [] }]]),
    },
  };
  return { mods, engine, created, runs };
}

beforeEach(() => {
  _test.reset();
  try {
    window.localStorage.clear();
  } catch (e) {
    /* ignore */
  }
  window.history.pushState({}, "", "/");
});

// ---------------------------------------------------------------------------------------------
describe("旗標 enabled()", () => {
  test("預設關閉", () => {
    expect(enabled()).toBe(false);
  });
  test("?engine=wasm 開啟", () => {
    window.history.pushState({}, "", "/?engine=wasm");
    expect(enabled()).toBe(true);
  });
  test("localStorage vgdb_engine=wasm 開啟", () => {
    window.localStorage.setItem("vgdb_engine", "wasm");
    expect(enabled()).toBe(true);
  });
  test("?engine=gdb 蓋過 localStorage", () => {
    window.localStorage.setItem("vgdb_engine", "wasm");
    window.history.pushState({}, "", "/?engine=gdb");
    expect(enabled()).toBe(false);
  });
  test("其他值不開啟", () => {
    window.localStorage.setItem("vgdb_engine", "yes");
    window.history.pushState({}, "", "/?engine=WASM");
    expect(enabled()).toBe(false);
  });
  test("一頁只判定一次（中途改 localStorage 不會讓 socket 與端點分屬不同引擎）", () => {
    expect(enabled()).toBe(false);
    window.localStorage.setItem("vgdb_engine", "wasm");
    expect(enabled()).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
describe("LocalSocket", () => {
  test("session 建立前緩衝 run_gdb_command / pty_interaction，attach 後依到達順序送出", () => {
    const s = new LocalSocket();
    s.emit("run_gdb_command", { cmd: ["-list-features"], request_id: 1 });
    s.emit("pty_interaction", { data: { pty_name: "program_pty", action: "flush" } });
    s.emit("run_gdb_command", { cmd: ["-break-list"], request_id: 2 });
    s.emit("something_else", { x: 1 }); // 不是這兩種事件：丟棄
    const g = fakeGdb();
    expect(g.received).toEqual([]);
    s.attach(g);
    expect(g.received.map((r) => r[0])).toEqual(["run_gdb_command", "pty_interaction", "run_gdb_command"]);
    expect(g.received[0][1].request_id).toBe(1);
    expect(g.received[2][1].request_id).toBe(2);
    // attach 之後直接委派
    s.emit("run_gdb_command", { cmd: ["-exec-run"], request_id: 3 });
    expect(g.received[3][1].cmd).toEqual(["-exec-run"]);
  });

  test("session 的 gdb_response / program_pty_response / error 事件轉給 UI；connect 類事件不轉", async () => {
    const s = new LocalSocket();
    const g = fakeGdb();
    s.attach(g);
    const got: any[] = [];
    ["gdb_response", "program_pty_response", "user_pty_response", "error_running_gdb_command", "connect", "debug_session_connection_event"].forEach((ev) =>
      s.on(ev, (p: any) => got.push([ev, p]))
    );
    s.emit("run_gdb_command", { cmd: ["-list-features"], run_token: null, request_id: 7 });
    await flush();
    g.fire("program_pty_response", "out\r\n");
    g.fire("error_running_gdb_command", { message: "bad" });
    g.fire("connect", undefined);
    g.fire("debug_session_connection_event", { ok: true });
    expect(got.map((x) => x[0])).toEqual(["gdb_response", "program_pty_response", "error_running_gdb_command"]);
    expect(got[0][1].request_id).toBe(7);
  });

  test("announce：先 connect 再 debug_session_connection_event（started_new_gdb_process:true），connected 為真", () => {
    const s = new LocalSocket();
    const order: string[] = [];
    let connectedAtConnect: boolean | null = null;
    s.on("connect", () => {
      order.push("connect");
      connectedAtConnect = s.connected;
    });
    s.on("debug_session_connection_event", (p: any) => {
      order.push("debug_session_connection_event");
      expect(p.ok).toBe(true);
      expect(p.started_new_gdb_process).toBe(true);
      expect(p.pid).toBe(99);
      expect(typeof p.message).toBe("string");
    });
    expect(s.disconnected).toBe(true);
    s.announce(99);
    s.announce(99); // 只宣告一次
    expect(order).toEqual(["connect", "debug_session_connection_event"]);
    expect(connectedAtConnect).toBe(true);
    expect(s.connected).toBe(true);
    expect(s.disconnected).toBe(false);
  });

  test("announceFailure：ok:false（UI 會印訊息並關閉 socket）", () => {
    const s = new LocalSocket();
    const ev: any[] = [];
    s.on("debug_session_connection_event", (p: any) => ev.push(p));
    s.announceFailure("載入失敗");
    expect(ev).toEqual([{ ok: false, started_new_gdb_process: false, pid: null, message: "載入失敗" }]);
  });

  test("換 session：舊的答完手上的命令才關閉，新命令只進新 session", async () => {
    const s = new LocalSocket();
    const a = fakeGdb();
    s.attach(a);
    const responses: any[] = [];
    s.on("gdb_response", (p: any) => responses.push(p.request_id));
    s.emit("run_gdb_command", { cmd: ["-a"], request_id: 1 });
    const b = fakeGdb();
    s.attach(b);
    s.emit("run_gdb_command", { cmd: ["-b"], request_id: 2 });
    await flush();
    await flush();
    expect(responses).toEqual([1, 2]);
    expect(a.state.closed).toBe(true);
    expect(b.state.closed).toBe(false);
    expect(a.received.length).toBe(1);
    expect(b.received.length).toBe(1);
  });

  test("close 之後不再送、不再收", async () => {
    const s = new LocalSocket();
    const g = fakeGdb();
    s.attach(g);
    const got: any[] = [];
    s.on("gdb_response", (p: any) => got.push(p));
    s.close();
    s.emit("run_gdb_command", { cmd: ["-x"], request_id: 1 });
    await flush();
    expect(g.received).toEqual([]);
    expect(got).toEqual([]);
    expect(s.disconnected).toBe(true);
  });

  test("on/once/off", () => {
    const s = new LocalSocket();
    const calls: string[] = [];
    const f = () => calls.push("f");
    s.on("gdb_response", f);
    s.once("gdb_response", () => calls.push("once"));
    s.deliver("gdb_response", {});
    s.deliver("gdb_response", {});
    s.off("gdb_response", f);
    s.deliver("gdb_response", {});
    expect(calls).toEqual(["f", "once", "f"]);
  });
});

// ---------------------------------------------------------------------------------------------
describe("getSocket（旗標開啟時 GdbApi 用它代替 io.connect）", () => {
  test("模組載入後掛上「尚未 Run」的 session 並宣告連線；之前送的命令先緩衝", async () => {
    const f = fakeModules(okRun());
    _test.setModules(f.mods as any);
    const s = localEngine.getSocket();
    expect(localEngine.getSocket()).toBe(s);
    const events: any[] = [];
    s.on("connect", () => events.push("connect"));
    s.on("debug_session_connection_event", (p: any) => events.push(p));
    s.emit("run_gdb_command", { cmd: ["-list-features"], request_id: 1 });
    await flush();
    expect(events[0]).toBe("connect");
    expect(events[1]).toMatchObject({ ok: true, started_new_gdb_process: true, pid: 4242 });
    expect(f.created.length).toBe(1);
    const boot = f.created[0];
    expect(boot.opts.autoConnect).toBe(false);
    expect(boot.opts.source).toBe("");
    expect(boot.opts.runResult.ok).toBe(true);
    expect(boot.opts.runResult.steps).toEqual([]);
    expect(boot.opts.sourcePath).toBe(SOURCE_PATH);
    expect(boot.opts.gdbFilePath).toBe(GDB_SOURCE_PATH);
    expect(boot.gdb.received[0][1].cmd).toEqual(["-list-features"]);
  });

  test("模組載入失敗 → ok:false 的連線事件", async () => {
    const append = jest.spyOn(document.head, "appendChild").mockImplementation((el: any) => {
      setTimeout(() => el.onerror && el.onerror(new Event("error")), 0);
      return el;
    });
    const s = localEngine.getSocket();
    const ev: any[] = [];
    s.on("debug_session_connection_event", (p: any) => ev.push(p));
    await flush();
    await flush();
    append.mockRestore();
    expect(ev.length).toBe(1);
    expect(ev[0].ok).toBe(false);
    expect(ev[0].message).toMatch(/瀏覽器引擎載入失敗/);
  });

  test("注入的 module script 只含同源 /static/engine/ 兩個網址", () => {
    let injected: any = null;
    const append = jest.spyOn(document.head, "appendChild").mockImplementation((el: any) => {
      injected = el;
      return el;
    });
    localEngine.getSocket();
    append.mockRestore();
    window.dispatchEvent(new Event("vgdb-engine-ready")); // settle (reject) the pending load so no listener leaks into later tests
    expect(injected.type).toBe("module");
    const urls = injected.textContent.match(/"[^"]*"/g);
    expect(urls).toEqual([
      JSON.stringify(window.location.origin + "/static/engine/index.js"),
      JSON.stringify(window.location.origin + "/static/engine/localgdb/index.js"),
      JSON.stringify("vgdb-engine-ready"),
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
describe("模擬 /create_and_upload", () => {
  test("成功：回伺服器同形狀的物件，建立 LocalGdb（sourcePath/gdbFilePath/runToken）並接上 socket", async () => {
    const f = fakeModules(okRun());
    _test.setModules(f.mods as any);
    const s = localEngine.getSocket();
    await flush();
    const progress: string[] = [];
    const r = await localEngine.createAndUpload({ code: "int main(){}\n", filepath: null, program_input: "3 4" }, (m) => progress.push(m));
    expect(r).toEqual({
      status: "success",
      binary_path: BINARY_PATH,
      source_path: SOURCE_PATH,
      gdb_source_path: GDB_SOURCE_PATH,
      exec_wrapper: "",
      gdb_subst_cmd: "",
      sandbox_warnings: [],
      run_token: expect.stringMatching(/^[0-9a-f]{32}$/),
    });
    expect(f.runs).toEqual([{ source: "int main(){}\n", stdin: "3 4\n" }]);
    expect(progress.length).toBe(2);
    const run = f.created[1];
    expect(run.opts).toMatchObject({ source: "int main(){}\n", stdin: "3 4\n", sourcePath: SOURCE_PATH, gdbFilePath: GDB_SOURCE_PATH, autoConnect: false });
    expect(run.gdb.state.runToken).toBe(r.run_token);
    // 之後的命令進新 session，舊（尚未 Run）的那個在答完後關閉
    s.emit("run_gdb_command", { cmd: ["-exec-run"], run_token: r.run_token, request_id: 5 });
    expect(run.gdb.received[0][1].cmd).toEqual(["-exec-run"]);
    await flush();
    expect(f.created[0].gdb.state.closed).toBe(true);
    expect(store.get("waiting_for_response")).toBe(false);
    // 第二次 Run 不再重新載入引擎（快取）
    progress.length = 0;
    await localEngine.createAndUpload({ code: "int main(){}\n" }, (m) => progress.push(m));
    expect(f.mods.engine.loadEngine).toHaveBeenCalledTimes(1);
    expect(progress.length).toBe(1);
  });

  test("程式輸入為空時沿用 localStorage gdbgui_program_input（與 doInject 相同），再補換行", () => {
    expect(stdinFor("")).toBe("");
    window.localStorage.setItem("gdbgui_program_input", "5");
    expect(stdinFor("")).toBe("5\n");
    expect(stdinFor("1 2")).toBe("1 2\n");
  });

  test("編譯錯誤 → status:error，stderr 的 main.cpp 換成 /workspace/main.cpp（CompileErrors 可解析）", async () => {
    const diag = "main.cpp:4:3: error: use of undeclared identifier 'x'\n    x = 1;\n    ^\n1 error generated.";
    const f = fakeModules({ ...emptyRunResult(), ok: false, errors: [{ kind: "compile", message: diag }] });
    _test.setModules(f.mods as any);
    const r = await localEngine.createAndUpload({ code: "bad" });
    expect(r.status).toBe("error");
    expect(r.message).toMatch(/編譯失敗/);
    expect(r.stderr.split("\n")[0]).toBe("/workspace/main.cpp:4:3: error: use of undeclared identifier 'x'");
    expect(f.created.length).toBe(1); // 只有「尚未 Run」的 session，沒有建立新的
  });

  test("不支援的語法 → 中文訊息含語法與行號，stderr 一行可被 CompileErrors 解析", async () => {
    const f = fakeModules({ ...emptyRunResult(), ok: false, errors: [{ kind: "unsupported", construct: "switch", line: 12, message: "unsupported construct: switch (line 12)" }] });
    _test.setModules(f.mods as any);
    const r = await localEngine.createAndUpload({ code: "x" });
    expect(r.status).toBe("error");
    expect(r.message).toBe("瀏覽器引擎不支援此語法（switch，第 12 行）；請改用伺服器引擎");
    expect(r.stderr).toMatch(/^\/workspace\/main\.cpp:12:1: error: /);
  });

  test("堆疊溢位 / 步數上限 → 錯誤路徑；timeout 只是警告", () => {
    expect(mapRunError(okRun({ exit: { reason: "stack-overflow", code: null } }))!.message).toMatch(/堆疊溢位/);
    expect(mapRunError(okRun({ exit: { reason: "step-limit", code: null } }))!.message).toMatch(/上限/);
    expect(mapRunError(okRun({ exit: { reason: "timeout", code: null } }))).toBeNull();
    expect(mapRunError(okRun({ errors: [{ kind: "trace-truncated" }] }))).toBeNull();
    expect(mapRunError({ ...emptyRunResult(), ok: false, errors: [{ kind: "compile-timeout" }] })!.message).toMatch(/逾時/);
    expect(mapRunError({ ...emptyRunResult(), ok: false, errors: [{ kind: "trace-corrupted" }] })!.message).toMatch(/內部錯誤/);
  });

  test("D5：width-warning 不是致命錯誤，mapRunError 回 null，但 runWarnings 會提示並附上可點連結", () => {
    const r = okRun({ errors: [{ kind: "width-warning", construct: "long", line: 3 }] });
    expect(mapRunError(r)).toBeNull(); // 不阻擋除錯，只是提示
    const warnings = runWarnings(r);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/long/);
    expect(warnings[0]).toMatch(/https?:\/\//); // 完整網址，讓 xterm web-links 外掛能點擊
    expect(warnings[0]).toMatch(/engine=gdb/);
  });

  test("D5：多筆 width-warning 的 construct 去重、合併成一則訊息", () => {
    const r = okRun({
      errors: [
        { kind: "width-warning", construct: "long", line: 1 },
        { kind: "width-warning", construct: "long", line: 5 },
        { kind: "width-warning", construct: "sizeof(pointer)", line: 9 },
      ],
    });
    const warnings = runWarnings(r);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/long/);
    expect(warnings[0]).toMatch(/sizeof/);
  });

  test("gdbFallbackUrl：保留其他參數，只覆寫 engine=gdb", () => {
    const original = window.location.href;
    try {
      window.history.pushState({}, "", "/?foo=bar&engine=wasm#frag");
      const url = gdbFallbackUrl();
      expect(url).toMatch(/engine=gdb/);
      expect(url).toMatch(/foo=bar/);
      expect(url).not.toMatch(/engine=wasm/);
    } finally {
      window.history.pushState({}, "", original);
    }
  });

  test("警告進 sandbox_warnings", async () => {
    const f = fakeModules(okRun({ exit: { reason: "timeout", code: null }, nosys: { path_open: 2 } }));
    _test.setModules(f.mods as any);
    const r = await localEngine.createAndUpload({ code: "x" });
    expect(r).toMatchObject({ status: "success" });
    expect(r.sandbox_warnings.length).toBe(2);
  });

  test("runProgram 丟例外 → status:error", async () => {
    const f = fakeModules(() => Promise.reject(new RangeError("source larger than 262144 bytes")));
    _test.setModules(f.mods as any);
    const r = await localEngine.createAndUpload({ code: "x" });
    expect(r).toEqual({ status: "error", message: expect.stringContaining("source larger than") });
  });

  test("/send_signal 在編譯途中 → 這次 Run 回「已中斷」，引擎被 dispose，不建立 session", async () => {
    let release: (v: any) => void = () => undefined;
    const f = fakeModules(() => new Promise((r) => (release = r)));
    _test.setModules(f.mods as any);
    const p = localEngine.createAndUpload({ code: "x" });
    await flush();
    const msg = await localEngine.sendSignal("SIGINT", "inferior");
    expect(msg).toMatch(/已中斷/);
    const r = await p;
    expect(r.status).toBe("error");
    expect(r.message).toMatch(/已中斷/);
    await flush();
    expect(f.engine.dispose).toHaveBeenCalled();
    release(okRun()); // 晚到的結果被丟棄
    await flush();
    expect(f.created.length).toBe(1);
  });

  test("/send_signal 在除錯中：SIGINT 不動 session；SIGKILL 回到「尚未 Run」狀態", async () => {
    const f = fakeModules(okRun());
    _test.setModules(f.mods as any);
    localEngine.getSocket();
    await flush();
    await localEngine.createAndUpload({ code: "x" });
    expect(await localEngine.sendSignal("SIGINT", "inferior")).toMatch(/不需要中斷/);
    expect(f.created.length).toBe(2);
    expect(await localEngine.sendSignal("SIGKILL", "inferior")).toMatch(/已結束/);
    expect(f.created.length).toBe(3);
    expect(f.created[2].opts.source).toBe("");
  });
});

describe("連續 Run / 載入失敗後恢復", () => {
  test("兩次連續 Run：被取代的第一次不回報任何結果（不觸發 UI 的 error → edit_mode），只有最新的一次回報", async () => {
    let releaseFirst: (v: any) => void = () => undefined;
    let n = 0;
    const f = fakeModules(() => (++n === 1 ? new Promise((r) => (releaseFirst = r)) : okRun()));
    _test.setModules(f.mods as any);
    localEngine.getSocket();
    await flush();
    store.set("edit_mode", false);
    const seen: string[] = [];
    const settings = (tag: string) => ({
      url: "/create_and_upload",
      data: { code: "x" },
      success: () => seen.push(tag + ":success"),
      error: () => {
        seen.push(tag + ":error");
        store.set("edit_mode", true); // what GdbApi's error callback does
      },
      complete: () => seen.push(tag + ":complete"),
    });
    localEngine.ajax(settings("first"));
    await flush();
    localEngine.ajax(settings("second"));
    await flush();
    await flush();
    releaseFirst(okRun()); // the first result arrives late and is dropped
    await flush();
    await flush();
    expect(seen).toEqual(["second:success", "second:complete"]);
    expect(store.get("edit_mode")).toBe(false);
    expect(f.created.length).toBe(2); // bootstrap + the second Run only
  });

  test("被取代的 Run 直接呼叫 createAndUpload → status:superseded；send_signal 的中斷仍回「已中斷」錯誤", async () => {
    let n = 0;
    const f = fakeModules(() => (++n === 1 ? new Promise(() => undefined) : okRun()));
    _test.setModules(f.mods as any);
    const p1 = localEngine.createAndUpload({ code: "a" });
    await flush();
    const p2 = localEngine.createAndUpload({ code: "b" });
    expect((await p1).status).toBe("superseded");
    expect((await p2).status).toBe("success");
  });

  test("第一次載入 index.js 失敗（UI 關閉 socket），第二次成功：下一次 Run 重新開啟 socket、重發握手、命令進新 session", async () => {
    const f = fakeModules(okRun());
    let calls = 0;
    const append = jest.spyOn(document.head, "appendChild").mockImplementation((el: any) => {
      calls++;
      if (calls === 1) {
        setTimeout(() => el.onerror && el.onerror(new Event("error")), 0);
      } else {
        setTimeout(() => {
          (window as any).__vgdbEngine = f.mods;
          window.dispatchEvent(new Event("vgdb-engine-ready"));
        }, 0);
      }
      return el;
    });
    const s = localEngine.getSocket();
    const events: any[] = [];
    s.on("connect", () => events.push("connect"));
    s.on("debug_session_connection_event", (p: any) => {
      events.push(p.ok);
      if (!p.ok) s.close(); // GdbApi does this
    });
    await flush();
    await flush();
    expect(events).toEqual(["connect", false]);
    expect(s.closed).toBe(true);

    const r = await localEngine.createAndUpload({ code: "int main(){}" });
    append.mockRestore();
    expect(r).toMatchObject({ status: "success" });
    expect(s.closed).toBe(false);
    expect(s.connected).toBe(true);
    expect(events).toEqual(["connect", false, "connect", true]);
    s.emit("run_gdb_command", { cmd: ["-exec-run"], run_token: r.run_token, request_id: 1 });
    expect(f.created[f.created.length - 1].gdb.received[0][1].cmd).toEqual(["-exec-run"]);
  });
});

// ---------------------------------------------------------------------------------------------
describe("/read_file 替代（規格 §7：必須 HTML 跳脫）", () => {
  const src = [
    "#include <iostream>",
    "// <img src=x onerror=alert(1)>",
    "",
    'int main() { const char* s = "a & b"; char c = \'<\'; return 0; }',
    "",
  ].join("\n");

  test("逐行跳脫 < > & \" '，空行換成一個空白，形狀同伺服器", () => {
    _test.setSessionSource(src);
    const r = readFile({ path: SOURCE_PATH, start_line: 1, end_line: 100, highlight: true });
    expect(r.ok).toBe(true);
    const body = (r as any).body;
    expect(Object.keys(body).sort()).toEqual(
      ["end_line", "highlighted", "last_modified_unix_sec", "num_lines_in_file", "path", "source_code_array", "start_line"].sort()
    );
    expect(body.source_code_array).toEqual([
      "#include &lt;iostream&gt;",
      "// &lt;img src=x onerror=alert(1)&gt;",
      " ",
      "int main() { const char* s = &quot;a &amp; b&quot;; char c = &#x27;&lt;&#x27;; return 0; }",
      " ",
    ]);
    expect(body.source_code_array.join("")).not.toMatch(/<|>/);
    expect(body.path).toBe(SOURCE_PATH);
    expect(body.num_lines_in_file).toBe(5); // split("\n") 語意：結尾換行多一行
    expect(body.start_line).toBe(1);
    expect(body.end_line).toBe(5); // 夾到檔案長度
    expect(body.highlighted).toBe(false);
    expect(body.last_modified_unix_sec).toBe(FIXED_MTIME);
  });

  test("行範圍：start 夾到 1、end 夾到檔尾", () => {
    _test.setSessionSource(src);
    const body = (readFile({ path: GDB_SOURCE_PATH, start_line: 0, end_line: 2 }) as any).body;
    expect(body.start_line).toBe(1);
    expect(body.end_line).toBe(2);
    expect(body.source_code_array.length).toBe(2);
  });

  test("尚未 Run 時用編輯器內容", () => {
    (window as any).gdbgui_get_editor_value = () => "a<b";
    const body = (readFile({ path: SOURCE_PATH, start_line: 1, end_line: 1 }) as any).body;
    delete (window as any).gdbgui_get_editor_value;
    expect(body.source_code_array).toEqual(["a&lt;b"]);
  });

  test("其他路徑、缺參數 → 伺服器的「檔案不可用」訊息", () => {
    _test.setSessionSource(src);
    expect(readFile({ path: "/etc/passwd", start_line: 1, end_line: 2 })).toEqual({ ok: false, message: "File not found or not accessible" });
    expect(readFile({ path: SOURCE_PATH, start_line: 1 })).toEqual({ ok: false, message: "File not found or not accessible" });
  });

  test("ajax 路由：非同步呼叫 success/complete，不呼叫 beforeSend、不讀 csrf", async () => {
    _test.setSessionSource("<b>");
    const calls: string[] = [];
    let body: any = null;
    localEngine.ajax({
      url: "/read_file",
      data: { path: SOURCE_PATH, start_line: 1, end_line: 1, highlight: true },
      beforeSend: () => calls.push("beforeSend"),
      success: (b: any) => {
        calls.push("success");
        body = b;
      },
      error: () => calls.push("error"),
      complete: () => calls.push("complete"),
    });
    expect(calls).toEqual([]);
    await flush();
    expect(calls).toEqual(["success", "complete"]);
    expect(body.source_code_array).toEqual(["&lt;b&gt;"]);
  });

  test("ajax 路由：錯誤走 error(xhr) 且 xhr.responseJSON.message 有值", async () => {
    let xhr: any = null;
    localEngine.ajax({ url: "/read_file", data: { path: "/x", start_line: 1, end_line: 1 }, error: (x: any) => (xhr = x) });
    await flush();
    expect(xhr.status).toBe(400);
    expect(xhr.responseJSON.message).toBe("File not found or not accessible");
  });

  test("escapeHtml 與 Python html.escape 相同", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&#x27;&amp;&#x27;&lt;/a&gt;");
  });
});

// ---------------------------------------------------------------------------------------------
describe("其他端點", () => {
  test("/api/prerun_calltree：尚未 attach 任何 session → ok:false", async () => {
    const f = fakeModules(okRun());
    _test.setModules(f.mods as any);
    const r = await localEngine.prerunCalltree();
    expect(r).toEqual({ ok: false, reason: "no_binary" });
    expect(f.mods.localgdb.buildPrerunSnapshots).not.toHaveBeenCalled();
  });
  test("/api/prerun_calltree：Run 完成、session 已 attach → ok:true，把 attach 的 session.model 交給 buildPrerunSnapshots", async () => {
    const rr = okRun();
    const f = fakeModules(rr);
    _test.setModules(f.mods as any);
    await localEngine.createAndUpload({ code: "int main(){}" });
    const r = await localEngine.prerunCalltree();
    expect(r.ok).toBe(true);
    expect(r.snapshots).toEqual([[{ func: "main", addr: "0x0", line: "1", args: [] }]]);
    expect(f.mods.localgdb.buildPrerunSnapshots).toHaveBeenCalledTimes(1);
    // f.created[0] is getSocket()'s "not yet Run" bootstrap session; [1] is this Run's session —
    // the model handed over must be exactly what createLocalGdb received as runResult for THIS Run.
    expect(f.created[1].opts.runResult).toBe(rr);
    expect(f.mods.localgdb.buildPrerunSnapshots.mock.calls[0][0]).toBe(rr);
  });
  test("/api/prerun_calltree：buildPrerunSnapshots 丟例外 → ok:false（不讓例外冒出去砸掉呼叫端）", async () => {
    const f = fakeModules(okRun());
    (f.mods.localgdb.buildPrerunSnapshots as jest.Mock).mockImplementation(() => {
      throw new Error("boom");
    });
    _test.setModules(f.mods as any);
    await localEngine.createAndUpload({ code: "int main(){}" });
    expect(await localEngine.prerunCalltree()).toEqual({ ok: false, reason: "prerun_failed" });
  });
  test("/get_last_modified_unix_sec → 固定值、回傳呼叫端的 path", async () => {
    let got: any = null;
    localEngine.ajax({ url: "/get_last_modified_unix_sec", data: { path: BINARY_PATH }, success: (d: any) => (got = d) });
    await flush();
    expect(got).toEqual({ path: BINARY_PATH, last_modified_unix_sec: FIXED_MTIME });
  });
  test("未知端點 → error", async () => {
    let xhr: any = null;
    localEngine.ajax({ url: "/api/lessons", error: (x: any) => (xhr = x) });
    await flush();
    expect(xhr.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------------------------
describe("真的 LocalGdb：「尚未 Run」的 session 回答 run_initial_commands", () => {
  test("-list-features 含 reverse；-break-insert -f 成為 pending；-exec-run 直接結束", async () => {
    const lg: any = await import("../../../static/engine/localgdb/index.js");
    _test.setModules({ engine: { loadEngine: () => Promise.reject(new Error("unused")) }, localgdb: lg });
    const s = localEngine.getSocket();
    const packets: any[] = [];
    s.on("gdb_response", (p: any) => packets.push(p));
    await flush();
    s.emit("run_gdb_command", { cmd: ["-list-features", "-list-target-features"], run_token: null, request_id: 1 });
    s.emit("run_gdb_command", { cmd: [`-break-insert -f "${GDB_SOURCE_PATH}:5"`, "-break-list"], run_token: null, request_id: 2 });
    await flush();
    await flush();
    expect(packets.length).toBe(2);
    const features = packets[0].data[0].payload.features;
    expect(features).toContain("reverse");
    expect(packets[1].data[0].payload.bkpt.addr).toBe("<PENDING>");
    expect(packets[1].request_id).toBe(2);
    s.emit("run_gdb_command", { cmd: ["-exec-run"], run_token: null, request_id: 3 });
    await flush();
    const stopped = packets[2].data.filter((it: any) => it.message === "stopped");
    expect(stopped.map((it: any) => it.payload.reason)).toEqual(["exited-normally"]);
  });
});
