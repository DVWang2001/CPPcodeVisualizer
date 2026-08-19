import ContainerVisualizer from "../ContainerVisualizer";
import { global_variable } from "../global_variable";
import { store } from "statorgfc";
import initialStoreData from "../InitialStoreData";

beforeAll(() => {
  // @ts-expect-error statorgfc's old declarations omit initialize.
  store.initialize({ ...initialStoreData }, { immutable: false, debounce_ms: 0 });
});

test("real container polling honors table-quiz auto-open suppression", () => {
  const open = jest.fn();
  (window as any).gdbgui_collapser_registry = { container: { open } };
  (window as any).gdbgui_table_quiz_hides_container = true;
  (global_variable as any).__latest_containers = new Map([
    ["dp", { type: "unsupported", values: [[1]] }]
  ]);
  (global_variable as any).__run_generation = 0;
  const visualizer = new (ContainerVisualizer as any)({});
  visualizer._lastResetRunGen = 0;
  visualizer.forceUpdate = jest.fn();

  visualizer._pollContainers();
  expect(open).not.toHaveBeenCalled();

  (window as any).gdbgui_table_quiz_hides_container = false;
  visualizer._pollContainers();
  expect(open).toHaveBeenCalledTimes(1);
});
