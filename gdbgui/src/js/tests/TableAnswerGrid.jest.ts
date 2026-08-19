import * as React from "react";
import * as ReactDOM from "react-dom";
import { act, Simulate } from "react-dom/test-utils";
import TableAnswerGrid from "../TableAnswerGrid";
import { StudentQuizTableQuestion } from "../studentQuizState";
import { loadDraft, saveDraft } from "../tableDraft";

const question = (overrides: Partial<StudentQuizTableQuestion> = {}): StudentQuizTableQuestion => ({
  id: "table-1",
  kind: "table",
  prompt: "填完 dp",
  rows: 2,
  cols: 2,
  row_labels: ["i=0", "i=1"],
  col_labels: ["j=0", "j=1"],
  source_file: "main.cpp",
  line: 8,
  state: "open",
  answer: null,
  ...overrides
});

let root: HTMLDivElement;

beforeEach(() => {
  localStorage.clear();
  root = document.createElement("div");
  document.body.appendChild(root);
});

afterEach(() => {
  act(() => {
    ReactDOM.unmountComponentAtNode(root);
  });
  root.remove();
});

function render(props: {
  question?: StudentQuizTableQuestion;
  submitted?: boolean;
  onSubmit?: (values: string[][]) => void;
} = {}) {
  act(() => {
    ReactDOM.render(
      React.createElement(TableAnswerGrid, {
        question: props.question || question(),
        submitted: props.submitted || false,
        onSubmit: props.onSubmit || jest.fn()
      }),
      root
    );
  });
}

test("grid uses text-compatible numeric inputs inside its own sticky scroller", () => {
  render();

  const inputs = Array.from(root.querySelectorAll("input"));
  expect(inputs).toHaveLength(4);
  expect(inputs[0].getAttribute("type")).toBeNull();
  expect(inputs[0].getAttribute("inputmode")).toBe("numeric");
  expect(inputs[0].getAttribute("maxlength")).toBe("32");
  expect(inputs[0].getAttribute("aria-label")).toContain("i=0");
  expect(inputs[0].getAttribute("aria-label")).toContain("j=0");
  expect((root.querySelector(".table-answer-scroll") as HTMLElement).style.overflow).toBe("auto");
  expect((root.querySelector(".table-answer-scroll") as HTMLElement).style.maxHeight).toBe("60vh");
  expect((root.querySelector(".table-answer-corner") as HTMLElement).style.position).toBe("sticky");
  expect((root.querySelector(".table-answer-col") as HTMLElement).style.position).toBe("sticky");
  expect((root.querySelector(".table-answer-row") as HTMLElement).style.position).toBe("sticky");
});

test("same grid instance replaces its draft with the server-owned answer", () => {
  saveDraft("table-1", [["1", "2"], ["3", "4"]]);
  render();
  expect(Array.from(root.querySelectorAll("input")).map(input => input.value)).toEqual([
    "1", "2", "3", "4"
  ]);

  render({
    submitted: true,
    question: question({
      state: "closed",
      answer: [["9", "8"], ["7", "6"]],
      correct_values: [["9", "0"], ["7", "0"]]
    })
  });
  expect(Array.from(root.querySelectorAll("input")).map(input => input.value)).toEqual([
    "9", "8", "7", "6"
  ]);
  expect(root.querySelector("input")!.classList.contains("is-correct")).toBe(true);
});

test("changing a cell saves the complete draft", () => {
  render();
  const input = root.querySelector("input") as HTMLInputElement;
  input.value = "42";

  act(() => Simulate.input(input));

  expect(loadDraft("table-1", 2, 2)).toEqual([["42", ""], ["", ""]]);
});

test("native mobile input survives the submitted transition", () => {
  const onSubmit = jest.fn();
  render({ onSubmit });
  const input = root.querySelector("input") as HTMLInputElement;
  input.value = "42";

  act(() => Simulate.input(input));
  act(() => Simulate.click(root.querySelector("button")!));
  render({ submitted: true, onSubmit });

  expect(onSubmit).toHaveBeenCalledWith([["42", ""], ["", ""]]);
  expect((root.querySelector("input") as HTMLInputElement).value).toBe("42");
});

test("Enter focuses the next cell in row-major order", () => {
  render();
  const inputs = Array.from(root.querySelectorAll("input")) as HTMLInputElement[];
  inputs[0].focus();

  act(() => Simulate.keyDown(inputs[0], { key: "Enter" } as any));

  expect(document.activeElement).toBe(inputs[1]);
});

test("submitted grid disables every cell", () => {
  render({ submitted: true });
  expect(Array.from(root.querySelectorAll("input")).every(input => input.disabled)).toBe(true);
});

test("closed grid marks each owned answer as correct or wrong with readable hints", () => {
  render({
    submitted: true,
    question: question({
      state: "closed",
      answer: [["0", "9"], ["1", ""]],
      correct_values: [["0", "1"], ["1", ""]]
    })
  });
  const inputs = Array.from(root.querySelectorAll("input"));

  expect(inputs[0].classList.contains("is-correct")).toBe(true);
  expect(inputs[0].getAttribute("aria-label")).toContain("答案正確");
  expect(inputs[1].classList.contains("is-wrong")).toBe(true);
  expect(inputs[1].getAttribute("aria-label")).toContain("答案錯誤，正確答案 1");
  expect(inputs[3].classList.contains("is-wrong")).toBe(true);
});
