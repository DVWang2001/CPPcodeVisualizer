import * as React from "react";
import * as ReactDOM from "react-dom";
import { act, Simulate } from "react-dom/test-utils";
jest.mock("../../css/liveQuiz.css", () => ({}));
jest.mock("../liveQuizClient", () => ({}));

import { closeQuizContainer, restoreQuizContainer, TableTriggerConfirm } from "../LiveQuizPanel";
import { PendingTable } from "../lessonQuizRuntime";
import { global_variable } from "../global_variable";

const pending: PendingTable = {
  questionId: "q1",
  sourceFile: "main.cpp",
  line: 3,
  tableSpec: { var_hint: "dp", max_cells: 20 }
};
let root: HTMLDivElement;

beforeEach(() => {
  root = document.createElement("div");
  document.body.appendChild(root);
  (global_variable as any).__latest_containers = new Map();
});

afterEach(() => {
  act(() => { ReactDOM.unmountComponentAtNode(root); });
  root.remove();
});

function render(onConfirm = jest.fn()) {
  act(() => {
    ReactDOM.render(
      React.createElement(TableTriggerConfirm, { pending, busy: false, onConfirm }),
      root
    );
  });
  return onConfirm;
}

test("no captured container disables confirmation with the required message", () => {
  render();

  expect(root.textContent).toContain("程式需先停在容器有值的位置");
  expect((root.querySelector("button") as HTMLButtonElement).disabled).toBe(true);
});

test("capture choices refresh when the paused debugger publishes containers", () => {
  jest.useFakeTimers();
  render();
  (global_variable as any).__latest_containers = new Map([["dp", { values: [[5]] }]]);

  act(() => { jest.advanceTimersByTime(1000); });

  expect((root.querySelector("select") as HTMLSelectElement).value).toBe("dp");
  expect((root.querySelector("button") as HTMLButtonElement).disabled).toBe(false);
  jest.useRealTimers();
});

test("preferred variable previews a valid table and confirms it explicitly", () => {
  (global_variable as any).__latest_containers = new Map([
    ["other", { values: [["9"]] }],
    ["dp", { values: [[1, 2], [3, 4]] }]
  ]);
  const onConfirm = render();

  expect((root.querySelector("select") as HTMLSelectElement).value).toBe("dp");
  expect(root.textContent).toContain("1");
  expect(root.textContent).toContain("4");
  act(() => Simulate.click(root.querySelector("button")!));
  expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ rows: 2, cols: 2 }), "dp");
});

test("invalid selected container shows the capture reason verbatim and never confirms", () => {
  (global_variable as any).__latest_containers = new Map([
    ["flat", { values: [1, 2] }],
    ["matrix", { values: [[7]] }]
  ]);
  const onConfirm = render();
  const select = root.querySelector("select") as HTMLSelectElement;

  act(() => Simulate.change(select, { target: { value: "flat" } } as any));

  expect(root.textContent).toContain("填表題需要二維容器，這個是一維的。");
  expect((root.querySelector("button") as HTMLButtonElement).disabled).toBe(true);
  expect(onConfirm).not.toHaveBeenCalled();
});

test("container visibility is restored only when the quiz flow closed an open panel", () => {
  const open = jest.fn();
  const close = jest.fn();
  (window as any).gdbgui_collapser_registry = {
    container: { isOpen: () => true, open, close }
  };

  const changed = closeQuizContainer();
  restoreQuizContainer(changed);

  expect(close).toHaveBeenCalledTimes(1);
  expect(open).toHaveBeenCalledTimes(1);

  close.mockClear();
  open.mockClear();
  (window as any).gdbgui_collapser_registry.container.isOpen = () => false;
  restoreQuizContainer(closeQuizContainer());
  expect(close).not.toHaveBeenCalled();
  expect(open).not.toHaveBeenCalled();
});
