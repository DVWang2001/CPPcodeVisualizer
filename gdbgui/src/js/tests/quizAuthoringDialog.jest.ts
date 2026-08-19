import * as React from "react";
import * as ReactDOM from "react-dom";
import { act } from "react-dom/test-utils";
import QuizAuthoringDialog from "../QuizAuthoringDialog";
import { QuizSpec } from "../quizSchema";

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

test("填表題在編輯器不渲染單選控制項", () => {
  const root = document.createElement("div");
  document.body.appendChild(root);

  act(() => {
    ReactDOM.render(
      React.createElement(QuizAuthoringDialog, {
        quiz: tableQuiz,
        sourceCode: "int main() {}",
        sourceFile: "main.cpp",
        getCursorLine: () => 1,
        onSave: jest.fn(),
        onClose: jest.fn()
      }),
      root
    );
  });

  expect(root.querySelector('input[type="radio"]')).toBeNull();
  act(() => {
    ReactDOM.unmountComponentAtNode(root);
  });
  root.remove();
});
