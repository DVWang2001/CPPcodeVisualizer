// Jest test environment setup.
// Runs before every test file (via jest.config.js setupFiles).

// jsdom bundled with Jest 24 does not implement requestAnimationFrame.
// BSTPlugin.afterFrame() depends on it, so we replace it with a synchronous
// polyfill so animations complete without a real browser frame loop.
(global as any).requestAnimationFrame = (callback: (time: number) => void): number => {
    callback(0);
    return 0;
};
(global as any).cancelAnimationFrame = (_handle: number): void => {};

// Ensure global_variable.js can initialise its window-backed singleton.
(window as any).gdbgui_global_variable = (window as any).gdbgui_global_variable || {};
(global as any).debug = false;
(window as any).initial_data = (window as any).initial_data || {
    csrf_token: "test-csrf",
    gdbpid: null,
    gdb_command: null,
    remap_sources: {},
    themes: ["light"],
    gdbgui_version: "test"
};
(global as any).initial_data = (window as any).initial_data;

// The production webpack build supplies synthetic default interop. ts-jest's
// CommonJS override does not, while a few legacy modules still import React as default.
const ReactModule = require("react");
if (!ReactModule.default) ReactModule.default = ReactModule;
