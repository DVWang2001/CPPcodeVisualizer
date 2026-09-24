// ── 在 expressions 陣列裡找「最新」一筆同名運算式 ──────────────────────────
//
// step-out/step-in 按太快時，前一個 graphics_instruction 任務對某個運算式
// （例如迴圈索引 "i - 1"）的 create_variable 請求可能還在飛，後一個任務就已經
// 開始跑：它在自己那一刻的 expressions 陣列裡找不到同名、in_scope 的舊 varobj
// 可以刪（前一個任務的還沒建好），於是也送出一筆同運算式的新建立請求。兩筆
// 請求都會成功，expressions 陣列裡因此同時存在兩筆 .expression 相同的紀錄——
// 一筆是前一個任務、代表「舊」那次停駐點的值，一筆是這次真正該用的。
//
// 原本的 `expressions.find(obj => obj.expression === X && obj.in_scope === "true")`
// 只會拿到「先被 push 進陣列」的那筆，也就是舊的那筆，用舊值去算要亮哪一格，
// 答案就跟畫面上實際停的地方對不上——這正是「step-out 按太快跳到某一行卻亮
// 錯格」的成因。save_new_expression（GdbVariable.tsx）一律是 push（陣列尾端
// 最新），所以從尾端往回找第一個相符的，才會拿到最近一次求值的結果。

export interface ExprLike {
  expression: string;
  in_scope: string;
}

export function findLatestExpr<T extends ExprLike>(
  expressions: T[],
  expression: string
): T | undefined {
  for (let i = expressions.length - 1; i >= 0; i--) {
    if (expressions[i].expression === expression && expressions[i].in_scope === "true") {
      return expressions[i];
    }
  }
  return undefined;
}

// ── 同名運算式的「全部」in_scope 紀錄 ─────────────────────────────────────
//
// 同一個變數（例如迴圈裡的 r）可能同時被兩條路徑管：指導欄的 `{r}` 與高亮索引
// `{dp[r][j + 1]}` 的列／欄。第一次停駐時兩條路徑各建一份，expressions 裡就有
// 兩筆同名紀錄。之後高亮那條路徑「只刪最新一筆再重建」，重建完成前讀值會讀到
// 留下來的另一筆——它的值還停在上一次停駐點（-var-update 的結果尚未套用），
// 於是第二次進到同一行時高亮還是上一次的格子。所以重建前要把同名的全部舊紀錄
// 一起刪掉，讀值時就只剩剛建好的那一筆。
export function findAllExpr<T extends ExprLike>(
  expressions: T[],
  expression: string
): T[] {
  return expressions.filter(
    (obj) => obj.expression === expression && obj.in_scope === "true"
  );
}

