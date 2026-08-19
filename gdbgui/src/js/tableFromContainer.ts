/** A validated two-dimensional container snapshot suitable for table quizzes. */
export type CapturedTable = {
    rows: number;
    cols: number;
    row_labels: string[];
    col_labels: string[];
    values: string[][];
};

export type TableCaptureResult =
    | { ok: true; table: CapturedTable }
    | { ok: false; reason: string };

export const MAX_CELL_LENGTH = 32;

export function tableFromContainer(payload: any, maxCells: number): TableCaptureResult {
    const values = payload && payload.values;
    if (!Array.isArray(values) || values.length === 0) {
        return { ok: false, reason: "這個容器沒有內容。" };
    }
    if (!Array.isArray(values[0])) {
        return { ok: false, reason: "填表題需要二維容器，這個是一維的。" };
    }

    const rows = values.length;
    const cols = values[0].length;
    if (cols === 0) {
        return { ok: false, reason: "這個容器的第 1 列是空的。" };
    }

    for (let i = 0; i < rows; i++) {
        if (!Array.isArray(values[i]) || values[i].length !== cols) {
            const actual = Array.isArray(values[i]) ? values[i].length : "?";
            return { ok: false, reason: `第 ${i + 1} 列有 ${actual} 格，與第 1 列的 ${cols} 格不一致。` };
        }
    }

    const cellCount = rows * cols;
    if (cellCount > maxCells) {
        return { ok: false, reason: `這張表有 ${rows}×${cols}=${cellCount} 格，超過上限 ${maxCells} 格。` };
    }

    const out: string[][] = [];
    for (let i = 0; i < rows; i++) {
        const line: string[] = [];
        for (let j = 0; j < cols; j++) {
            const cell = String(values[i][j]);
            if (cell.length > MAX_CELL_LENGTH) {
                return { ok: false, reason: `第 ${i + 1} 列第 ${j + 1} 格的內容過長，填表題只適用純量。` };
            }
            line.push(cell);
        }
        out.push(line);
    }

    return {
        ok: true,
        table: {
            rows,
            cols,
            row_labels: Array.from({ length: rows }, (_, i) => String(i)),
            col_labels: Array.from({ length: cols }, (_, j) => String(j)),
            values: out,
        },
    };
}
