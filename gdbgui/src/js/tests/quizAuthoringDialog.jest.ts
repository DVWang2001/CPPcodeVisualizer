import * as React from "react";
import * as ReactDOM from "react-dom";
import { act, Simulate } from "react-dom/test-utils";
import QuizAuthoringDialog from "../QuizAuthoringDialog";
import { QuizSpec } from "../quizSchema";
import { global_variable } from "../global_variable";

const tableQuiz: QuizSpec = {
  schema_version: 1,
  questions: [{
    id: "t1",
    kind: "table",
    prompt: "填表",
    explanation: "",
    trigger: {
      kind: "source_line",
      source_file: "main.cpp",
      line: 1,
      anchor: { line_text: "int main() {}", before_text: "", after_text: "" }
    },
    table_spec: { var_hint: "dp", max_cells: 4 }
  }]
};

function renderDialog(quiz: QuizSpec, onSave = jest.fn(), readOnly = false) {
  const root = document.createElement("div");
  document.body.appendChild(root);
  act(() => {
    ReactDOM.render(
      React.createElement(QuizAuthoringDialog, {
        quiz,
        sourceCode: "int main() {}",
        sourceFile: "main.cpp",
        getCursorLine: () => 1,
        onSave,
        onClose: jest.fn(),
        readOnly
      }),
      root
    );
  });
  return { root, onSave };
}

function cleanup(root: HTMLElement) {
  act(() => { ReactDOM.unmountComponentAtNode(root); });
  root.remove();
}

afterEach(() => {
  delete (global_variable as any).__latest_containers;
});

test("填表控制項使用原生限制，沒有容器時提供明確退路", () => {
  const { root } = renderDialog(tableQuiz);
  const kind = root.querySelector('select[aria-label="第 1 題題型"]') as HTMLSelectElement;
  const hint = root.querySelector('input[aria-label="第 1 題變數提示"]') as HTMLInputElement;
  const limit = root.querySelector('input[aria-label="第 1 題格數上限"]') as HTMLInputElement;
  const picker = Array.from(root.querySelectorAll("button")).find(button =>
    button.textContent!.includes("從畫面上的容器選擇")
  ) as HTMLButtonElement;

  expect(kind.value).toBe("table");
  expect(hint.maxLength).toBe(128);
  expect(limit.type).toBe("number");
  expect([limit.min, limit.max, limit.step, limit.value]).toEqual(["1", "200", "1", "4"]);
  expect(picker.disabled).toBe(true);
  expect(root.textContent).toContain("可留空");
  expect(root.querySelector('input[type="radio"]')).toBeNull();
  cleanup(root);
});

test("可從畫面容器寫入提示並儲存純填表 payload", () => {
  (global_variable as any).__latest_containers = new Map([["dp", {}], ["cost", {}]]);
  const onSave = jest.fn();
  const { root } = renderDialog(tableQuiz, onSave);
  const picker = Array.from(root.querySelectorAll("button")).find(button =>
    button.textContent!.includes("從畫面上的容器選擇")
  ) as HTMLButtonElement;

  act(() => { Simulate.click(picker); });
  const containers = root.querySelector('select[aria-label="第 1 題畫面上的容器"]') as HTMLSelectElement;
  act(() => { Simulate.change(containers, { target: { value: "cost" } } as any); });
  expect((root.querySelector('input[aria-label="第 1 題變數提示"]') as HTMLInputElement).value).toBe("cost");

  const save = Array.from(root.querySelectorAll("button")).find(button => button.textContent === "儲存題目")!;
  act(() => { Simulate.click(save); });
  expect(onSave).toHaveBeenCalledWith({
    ...tableQuiz,
    questions: [{ ...tableQuiz.questions[0], table_spec: { var_hint: "cost", max_cells: 4 } }]
  });
  cleanup(root);
});

test("題型下拉可來回切換且填表預設為 200 格", () => {
  const choiceQuiz: QuizSpec = {
    questions: [{
      id: "t1",
      kind: "choice",
      prompt: "填表",
      explanation: "",
      trigger: tableQuiz.questions[0].trigger,
      options: [{ id: "a", text: "1" }, { id: "b", text: "2" }],
      correct_option_id: "a"
    }],
    schema_version: 1
  };
  const { root } = renderDialog(choiceQuiz);
  let kind = root.querySelector('select[aria-label="第 1 題題型"]') as HTMLSelectElement;

  act(() => { Simulate.change(kind, { target: { value: "table" } } as any); });
  expect((root.querySelector('input[aria-label="第 1 題格數上限"]') as HTMLInputElement).value).toBe("200");
  expect(root.querySelector('input[type="radio"]')).toBeNull();

  kind = root.querySelector('select[aria-label="第 1 題題型"]') as HTMLSelectElement;
  act(() => { Simulate.change(kind, { target: { value: "choice" } } as any); });
  expect(root.querySelectorAll('input[type="radio"]')).toHaveLength(2);
  expect(root.querySelector('input[aria-label="第 1 題變數提示"]')).toBeNull();
  cleanup(root);
});

test("填表格數不合法時不能儲存，唯讀時新控制項全停用", () => {
  let rendered = renderDialog(tableQuiz);
  const limit = rendered.root.querySelector('input[aria-label="第 1 題格數上限"]') as HTMLInputElement;
  act(() => { Simulate.change(limit, { target: { value: "201" } } as any); });
  expect(Array.from(rendered.root.querySelectorAll("button")).find(button =>
    button.textContent === "儲存題目"
  )!.disabled).toBe(true);
  act(() => { Simulate.change(limit, { target: { value: "1.5" } } as any); });
  expect(Array.from(rendered.root.querySelectorAll("button")).find(button =>
    button.textContent === "儲存題目"
  )!.disabled).toBe(true);
  cleanup(rendered.root);

  rendered = renderDialog(tableQuiz, jest.fn(), true);
  expect(rendered.root.querySelector('select[aria-label="第 1 題題型"]')!.matches(":disabled")).toBe(true);
  expect(rendered.root.querySelector('input[aria-label="第 1 題變數提示"]')!.matches(":disabled")).toBe(true);
  expect(rendered.root.querySelector('input[aria-label="第 1 題格數上限"]')!.matches(":disabled")).toBe(true);
  cleanup(rendered.root);
});
