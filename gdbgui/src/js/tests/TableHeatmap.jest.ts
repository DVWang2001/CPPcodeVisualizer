import * as React from "react";
import * as ReactDOM from "react-dom";
import { act } from "react-dom/test-utils";
jest.mock("../../css/liveQuiz.css", () => ({}));
import TableHeatmap from "../TableHeatmap";

let root: HTMLDivElement;

beforeEach(() => {
  root = document.createElement("div");
  document.body.appendChild(root);
});

afterEach(() => {
  act(() => { ReactDOM.unmountComponentAtNode(root); });
  root.remove();
});

test("heatmap renders labels, counts, and an amber ratio per cell", () => {
  act(() => {
    ReactDOM.render(
      React.createElement(TableHeatmap, {
        rows: 1,
        cols: 2,
        rowLabels: ["i=0"],
        colLabels: ["j=0", "j=1"],
        stats: [0, 2],
        answerCount: 4
      }),
      root
    );
  });

  const cells = Array.from(root.querySelectorAll("[data-heatmap-cell]")) as HTMLElement[];
  expect(cells).toHaveLength(2);
  expect(cells.map(cell => cell.textContent)).toEqual(["0", "2"]);
  expect(cells[1].getAttribute("aria-label")).toBe("i=0，j=1：4 人中有 2 人答錯");
  expect((cells[0].querySelector("[data-heat]") as HTMLElement).style.opacity).toBe("0");
  expect((cells[1].querySelector("[data-heat]") as HTMLElement).style.opacity).toBe("0.5");
  expect((cells[1].querySelector("[data-heat]") as HTMLElement).className).toBe("table-heatmap__heat");
  expect(cells[1].style.fontVariantNumeric).toBe("tabular-nums");
});

test("only cells with wrong answers become 44px jump buttons, and only when a handler is given", () => {
  const onCellClick = jest.fn();
  const render = (extra: object) => act(() => {
    ReactDOM.render(
      React.createElement(TableHeatmap, {
        rows: 1, cols: 2, rowLabels: ["2"], colLabels: ["1", "3"], stats: [0, 2], answerCount: 4, ...extra
      }),
      root
    );
  });
  render({});
  expect(root.querySelectorAll("button")).toHaveLength(0);
  render({ onCellClick, varName: "dp" });
  const buttons = Array.from(root.querySelectorAll("button")) as HTMLButtonElement[];
  expect(buttons).toHaveLength(1);
  expect(buttons[0].getAttribute("aria-label")).toBe("跳到 dp[0][1] 最後被寫入的那一步");
  expect(buttons[0].style.minHeight).toBe("44px");
  expect(buttons[0].style.minWidth).toBe("44px");
  act(() => { buttons[0].click(); });
  expect(onCellClick).toHaveBeenCalledWith(0, 1);
  // look and data unchanged: the cell is still the same td with the same text and label
  const cells = Array.from(root.querySelectorAll("[data-heatmap-cell]")) as HTMLElement[];
  expect(cells.map(c => c.textContent)).toEqual(["0", "2"]);
});
