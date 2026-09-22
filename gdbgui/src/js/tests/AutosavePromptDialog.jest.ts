import * as React from "react";
import * as ReactDOM from "react-dom";
import { act } from "react-dom/test-utils";

import AutosavePromptDialog from "../AutosavePromptDialog";

function render(props: Partial<React.ComponentProps<typeof AutosavePromptDialog>> = {}) {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const onContinue = jest.fn();
  const onDiscard = jest.fn();
  act(() => {
    ReactDOM.render(
      React.createElement(AutosavePromptDialog, {
        savedAt: null,
        filename: null,
        onContinue,
        onDiscard,
        ...props,
      } as any),
      root
    );
  });
  return { root, onContinue, onDiscard };
}

test("顯示檔名跟存檔時間", () => {
  const { root } = render({ savedAt: new Date("2026-01-02T03:04:05").getTime(), filename: "main.cpp" });
  const meta = root.querySelector('[data-testid="autosave-prompt-meta"]')!.textContent || "";
  expect(meta).toContain("main.cpp");
  expect(meta).toContain("2026");
});

test("沒有時間戳（舊版存檔）或檔名時不硬擠假資訊", () => {
  const { root } = render({ savedAt: null, filename: null });
  const meta = root.querySelector('[data-testid="autosave-prompt-meta"]')!.textContent || "";
  expect(meta).toBe("沒有檔名紀錄");
});

test("按「繼續編輯這份草稿」呼叫 onContinue，不呼叫 onDiscard", () => {
  const { root, onContinue, onDiscard } = render();
  (root.querySelector('[data-testid="autosave-prompt-continue"]') as HTMLElement).click();
  expect(onContinue).toHaveBeenCalledTimes(1);
  expect(onDiscard).not.toHaveBeenCalled();
});

test("按「捨棄，用空白範本」呼叫 onDiscard，不呼叫 onContinue", () => {
  const { root, onContinue, onDiscard } = render();
  (root.querySelector('[data-testid="autosave-prompt-discard"]') as HTMLElement).click();
  expect(onDiscard).toHaveBeenCalledTimes(1);
  expect(onContinue).not.toHaveBeenCalled();
});

test("Escape 等同捨棄", () => {
  const { root, onDiscard, onContinue } = render();
  const dialog = root.querySelector('[data-testid="autosave-prompt-dialog"]')!;
  dialog.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
  expect(onDiscard).toHaveBeenCalledTimes(1);
  expect(onContinue).not.toHaveBeenCalled();
});

test("Enter 等同繼續（預設動作是保留草稿，不是意外丟掉）", () => {
  const { root, onDiscard, onContinue } = render();
  const dialog = root.querySelector('[data-testid="autosave-prompt-dialog"]')!;
  dialog.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
  expect(onContinue).toHaveBeenCalledTimes(1);
  expect(onDiscard).not.toHaveBeenCalled();
});
