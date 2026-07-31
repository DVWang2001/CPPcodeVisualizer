import * as React from "react";
import * as ReactDOM from "react-dom";
import { act } from "react-dom/test-utils";

jest.mock("@monaco-editor/react", () => ({
  DiffEditor: () => React.createElement("div")
}));

import LessonCommitDialog from "../LessonCommitDialog";
import LessonHistoryDialog from "../LessonHistoryDialog";

const bundle = {
  version: "2.0",
  fullname_to_render: "main.cpp",
  source_code: "int main() {}"
};
const snapshot = {
  version: 1,
  parentVersion: null,
  title: "v1",
  bundle,
  createdAt: "now"
};

function key(target: Element, keyName: string, shiftKey = false) {
  target.dispatchEvent(
    new KeyboardEvent("keydown", { bubbles: true, key: keyName, shiftKey })
  );
}

test("commit dialog traps keyboard focus and returns it after Escape", () => {
  const opener = document.createElement("button");
  document.body.appendChild(opener);
  opener.focus();
  const root = document.createElement("div");
  document.body.appendChild(root);
  const onCancel = jest.fn();

  act(() => {
    ReactDOM.render(
      React.createElement(LessonCommitDialog, {
        baseline: snapshot,
        candidate: { title: "v2", bundle },
        onConfirm: jest.fn(),
        onCancel
      }),
      root
    );
  });
  const dialog = root.querySelector('[data-testid="lesson-commit-dialog"]')!;
  const cancel = root.querySelector(
    '[data-testid="lesson-commit-cancel"]'
  ) as HTMLElement;
  const confirm = root.querySelector(
    '[data-testid="lesson-commit-confirm"]'
  ) as HTMLElement;
  expect(document.activeElement).toBe(cancel);
  confirm.focus();
  key(dialog, "Tab");
  expect(document.activeElement).toBe(cancel);
  key(dialog, "Tab", true);
  expect(document.activeElement).toBe(confirm);
  key(dialog, "Escape");
  expect(onCancel).toHaveBeenCalledTimes(1);
  act(() => {
    ReactDOM.unmountComponentAtNode(root);
  });
  expect(document.activeElement).toBe(opener);
  root.remove();
  opener.remove();
});

test("history dialog focuses close control and closes with Escape", () => {
  const opener = document.createElement("button");
  document.body.appendChild(opener);
  opener.focus();
  const root = document.createElement("div");
  document.body.appendChild(root);
  const onClose = jest.fn();

  act(() => {
    ReactDOM.render(
      React.createElement(LessonHistoryDialog, {
        versions: [{ version: 1, parentVersion: null, createdAt: "now" }],
        currentVersion: 1,
        selected: null,
        parent: null,
        onSelect: jest.fn(),
        onRestore: jest.fn(),
        onClose
      }),
      root
    );
  });
  const dialog = root.querySelector('[data-testid="lesson-history-dialog"]')!;
  const close = root.querySelector('[data-testid="lesson-history-close"]') as HTMLElement;
  expect(document.activeElement).toBe(close);
  key(dialog, "Escape");
  expect(onClose).toHaveBeenCalledTimes(1);
  act(() => {
    ReactDOM.unmountComponentAtNode(root);
  });
  expect(document.activeElement).toBe(opener);
  root.remove();
  opener.remove();
});
