import { cameraTransform } from "../cameraTransform";

test("global mode fits the whole tree, centered horizontally", () => {
    const r = cameraTransform("global", 300, 200, 600, 400, null);
    // sc = min(600/300, 400/200) * 0.92 = 1.84
    expect(r.sc).toBeCloseTo(1.84, 5);
    // tx = (600 - 300*1.84)/2 = 24
    expect(r.tx).toBeCloseTo(24, 5);
    expect(r.ty).toBe(10);
});

test("global mode ignores an active node (whole tree still fits)", () => {
    const withActive = cameraTransform("global", 300, 200, 600, 400, { x: 100, y: 80, w: 150, h: 50 });
    const withoutActive = cameraTransform("global", 300, 200, 600, 400, null);
    expect(withActive).toEqual(withoutActive);
});

test("local mode centers the active node near the top, scale 1", () => {
    const r = cameraTransform("local", 300, 200, 600, 400, { x: 100, y: 80, w: 150, h: 50 });
    expect(r.sc).toBe(1);
    // tx = vw/2 - (cx + NW/2) = 300 - (100+75) = 125
    expect(r.tx).toBeCloseTo(125, 5);
    // ty = 88 - cy = 8
    expect(r.ty).toBeCloseTo(8, 5);
});

test("local mode with no active node falls back to global fit", () => {
    const r = cameraTransform("local", 300, 200, 600, 400, null);
    expect(r.sc).toBeCloseTo(1.84, 5);
    expect(r.tx).toBeCloseTo(24, 5);
    expect(r.ty).toBe(10);
});
