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
