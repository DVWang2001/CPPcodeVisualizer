import * as React from "react";
import { StudentTableResponse } from "./liveQuizClient";

type Props = {
  response: StudentTableResponse;
  correctValues: string[][];
  rowLabels: string[];
  colLabels: string[];
};

/**
 * 教師檢討用：唯讀地呈現某一位學生的填表作答，答錯的格子標出來。
 *
 * 刻意不重用學生端的 TableAnswerGrid：那個元件綁著草稿、送出與鎖定邏輯，而這裡什麼
 * 都不能改。共用會讓兩邊的需求互相拉扯，而它們只是「長得像」而已。
 */
export default function TableAnswerReview({
  response,
  correctValues,
  rowLabels,
  colLabels
}: Props) {
  const answer = response.answer;
  if (!answer) return <div style={{ color: "#667085" }}>這位學生沒有送出作答。</div>;

  return (
    <table style={{ borderCollapse: "collapse", tableLayout: "fixed", width: "100%" }}>
      <tbody>
        <tr>
          <th style={{ width: "22px" }} aria-hidden="true" />
          {colLabels.map((label, col) => (
            <th key={col} scope="col" style={head}>{label}</th>
          ))}
        </tr>
        {answer.map((line, row) => (
          <tr key={row}>
            <th scope="row" style={head}>{rowLabels[row]}</th>
            {line.map((value, col) => {
              const expected = (correctValues[row] || [])[col];
              const right = value.trim() === String(expected ?? "").trim();
              return (
                <td
                  key={col}
                  title={right ? "答對" : `正解 ${expected}`}
                  style={{
                    ...cell,
                    background: right ? "#edf8f0" : "#fff1f0",
                    color: right ? "#237a3b" : "#a61b1b"
                  }}
                >
                  {value.trim() === "" ? "—" : value}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const head: React.CSSProperties = {
  padding: "2px",
  color: "#4676b8",
  background: "#eef5ff",
  font: "700 10px/1.2 ui-monospace, Menlo, Consolas, monospace",
  textAlign: "center",
  border: "1px solid #d8dee9"
};

const cell: React.CSSProperties = {
  padding: "3px 2px",
  border: "1px solid #d8dee9",
  font: "700 11px/1.2 ui-monospace, Menlo, Consolas, monospace",
  textAlign: "center"
};
