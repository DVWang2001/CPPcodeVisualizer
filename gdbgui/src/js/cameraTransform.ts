// Pure camera-transform math for the CallGraph "global / local" view toggle.
// The tree layout itself is fixed (see callGraphLayout.ts); only the camera
// (translate + scale of the whole tree) changes between modes and as the
// active node changes. Kept side-effect free so it's trivially unit-testable
// and reusable for the render-time transform string.

export type ViewMode = "global" | "local";

// Minimal box for the currently-active node, in the fixed layout's
// coordinate space (top-left x/y + node width/height).
export interface CameraBox {
    x: number;
    y: number;
    w: number;
    h: number;
}

export interface CameraResult {
    tx: number;
    ty: number;
    sc: number;
}

// Active node stays ~88px from the top of the stage in local mode (matches
// the validated mockup); global mode pads 10px from the top when fitting.
const LOCAL_TOP_OFFSET = 88;
const GLOBAL_TOP_PAD = 10;
const GLOBAL_FIT_MARGIN = 0.92;

export function cameraTransform(
    mode: ViewMode,
    treeW: number,
    treeH: number,
    vw: number,
    vh: number,
    activeNode: CameraBox | null
): CameraResult {
    if (mode === "local" && activeNode) {
        const sc = 1;
        const tx = vw / 2 - (activeNode.x + activeNode.w / 2);
        const ty = LOCAL_TOP_OFFSET - activeNode.y;
        return { tx, ty, sc };
    }
    // Global mode (and local mode with no active node yet): fit the whole
    // fixed-layout tree into the viewport, centered horizontally.
    const sc = Math.min(vw / treeW, vh / treeH) * GLOBAL_FIT_MARGIN;
    const tx = (vw - treeW * sc) / 2;
    const ty = GLOBAL_TOP_PAD;
    return { tx, ty, sc };
}
