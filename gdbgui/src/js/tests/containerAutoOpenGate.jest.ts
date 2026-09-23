import { resolveContainerAutoOpenSuppression } from "../containerAutoOpenGate";

const PANEL_ALIASES: Record<string, string> = { memory: "memory_watch", pointer: "memory_watch" };
const resolveId = (id: string) => PANEL_ALIASES[id] || id;

describe("resolveContainerAutoOpenSuppression", () => {
  test("open:live_quiz（不含 container）代表 container 被連帶關閉，要壓住自動重開", () => {
    const tokens = ["open:live_quiz", "close:container"];
    const idsToOpen = new Set(["live_quiz"]);
    expect(resolveContainerAutoOpenSuppression(tokens, idsToOpen, resolveId)).toBe(true);
  });

  test("只有 close:container、沒有任何 open: 也要壓住自動重開", () => {
    const tokens = ["close:container"];
    const idsToOpen = new Set<string>();
    expect(resolveContainerAutoOpenSuppression(tokens, idsToOpen, resolveId)).toBe(true);
  });

  test("open:container 明確要求打開，解除壓制、恢復自動管理", () => {
    const tokens = ["sidebar:55", "open:container"];
    const idsToOpen = new Set(["container"]);
    expect(resolveContainerAutoOpenSuppression(tokens, idsToOpen, resolveId)).toBe(false);
  });

  test("open:container,callgraph 這種混合列表也算明確打開 container", () => {
    const tokens = ["open:container,callgraph"];
    const idsToOpen = new Set(["container", "callgraph"]);
    expect(resolveContainerAutoOpenSuppression(tokens, idsToOpen, resolveId)).toBe(false);
  });

  test("跟 container 無關的 layout（例如只有 pop:dp:orange）不動旗標", () => {
    const tokens = ["pop:dp:orange"];
    const idsToOpen = new Set<string>();
    expect(resolveContainerAutoOpenSuppression(tokens, idsToOpen, resolveId)).toBeNull();
  });

  test("close:locals（關別的面板，不是 container）不動旗標", () => {
    const tokens = ["close:locals"];
    const idsToOpen = new Set<string>();
    expect(resolveContainerAutoOpenSuppression(tokens, idsToOpen, resolveId)).toBeNull();
  });

  test("close:memory 用別名也能正確解析成 memory_watch，不誤判成 container", () => {
    const tokens = ["close:memory"];
    const idsToOpen = new Set<string>();
    expect(resolveContainerAutoOpenSuppression(tokens, idsToOpen, resolveId)).toBeNull();
  });
});
