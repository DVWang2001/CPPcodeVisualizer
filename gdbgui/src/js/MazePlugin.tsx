import React from "react";
import { ContainerData } from "./ContainerPlugin";
import { PluginOp } from "./AnimScheduler";

type ColorRule = { value: string; color: string };
type HighlightEntry = { index: number; color: string };

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

interface CellChangePayload {
    row: number;
    col: number;
    oldValue: string;
    newValue: string;
}

class MazePluginImpl {
    private prevJson = new Map<string, string>();
    private history  = new Map<string, string[][]>();
    // Cells currently transitioning (for CSS transition)
    private transitioning = new Map<string, Set<string>>(); // "row,col"

    diffOps(containerName: string, data: ContainerData): PluginOp[] {
        const values = data.values as string[][];
        const json = JSON.stringify(values);
        if (json === this.prevJson.get(containerName)) return [];
        this.prevJson.set(containerName, json);

        const oldGrid = this.history.get(containerName);
        this.history.set(containerName, values.map(row => [...(row as any[])]));

        if (!oldGrid) return []; // first encounter — no animation

        const ops: PluginOp[] = [];
        const rows = Math.min(oldGrid.length, values.length);
        for (let r = 0; r < rows; r++) {
            const oldRow = oldGrid[r] as string[];
            const newRow = values[r] as string[];
            const cols = Math.min(oldRow.length, newRow.length);
            for (let c = 0; c < cols; c++) {
                if (String(oldRow[c]) !== String(newRow[c])) {
                    ops.push({
                        type: 'cellChange',
                        payload: { row: r, col: c, oldValue: String(oldRow[c]), newValue: String(newRow[c]) } as CellChangePayload,
                    });
                }
            }
        }

        return ops;
    }

    async animateOp(containerName: string, op: PluginOp, requestRender: () => void): Promise<void> {
        if (op.type !== 'cellChange') return;
        const p = op.payload as CellChangePayload;
        const key = `${p.row},${p.col}`;
        const set = this.transitioning.get(containerName) ?? new Set<string>();
        set.add(key);
        this.transitioning.set(containerName, set);
        requestRender();
        await delay(200);
        set.delete(key);
        requestRender();
    }

    render(
        containerName: string,
        values: any[][],
        colorRules: ColorRule[],
        highlights?: HighlightEntry[]
    ): React.ReactNode {
        const CELL = 20;
        const cols = values.length > 0 ? (values[0] as any[]).length : 0;

        const customColorMap = new Map<number, string>();
        for (const rule of colorRules) {
            const n = parseInt(rule.value);
            if (!isNaN(n) && n !== 0 && n !== 1) customColorMap.set(n, rule.color);
        }

        const mazePosMap = new Map<string, string>();
        if (highlights && cols > 0) {
            for (const h of highlights) {
                const r = Math.floor(h.index / cols);
                const c = h.index % cols;
                mazePosMap.set(`${r},${c}`, h.color === 'default' ? '#f59e0b' : h.color);
            }
        }

        const transSet = this.transitioning.get(containerName) ?? new Set<string>();

        return React.createElement('div', {
            style: { display: 'inline-block', border: '3px solid #444', lineHeight: 0, boxShadow: '2px 2px 8px rgba(0,0,0,0.35)' },
        },
            ...values.map((row: any[], rowIdx: number) =>
                React.createElement('div', { key: rowIdx, style: { display: 'flex' } },
                    ...(row as any[]).map((cell: any, colIdx: number) => {
                        const cellNum = parseInt(cell);
                        const mazeHL = mazePosMap.get(`${rowIdx},${colIdx}`);
                        const isTransitioning = transSet.has(`${rowIdx},${colIdx}`);
                        let bg: string;
                        if (mazeHL) bg = mazeHL;
                        else if (cellNum === 0) bg = '#f5f0e8';
                        else if (cellNum === 1) bg = '#2c2c2c';
                        else if (customColorMap.has(cellNum)) bg = customColorMap.get(cellNum)!;
                        else bg = '#888888';

                        return React.createElement('div', {
                            key: colIdx,
                            title: `[${rowIdx}][${colIdx}] = ${cell}`,
                            style: {
                                width: CELL, height: CELL, backgroundColor: bg,
                                boxSizing: 'border-box' as const,
                                border: cellNum === 1 ? 'none' : '1px solid rgba(180,160,120,0.25)',
                                transition: isTransitioning ? 'background-color 200ms ease' : 'none',
                            },
                        });
                    })
                )
            )
        );
    }

    resetAll(): void {
        this.prevJson.clear();
        this.history.clear();
        this.transitioning.clear();
    }

    resetContainer(containerName: string): void {
        this.prevJson.delete(containerName);
        this.history.delete(containerName);
        this.transitioning.delete(containerName);
    }
}

export const mazePlugin = new MazePluginImpl();
