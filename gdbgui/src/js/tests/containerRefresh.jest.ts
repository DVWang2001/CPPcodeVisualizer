// 停在第 L 行時，畫面顯示「第 L 行執行後」的狀態：容器面板上已經畫出來的容器每一站都要重讀，
// 不能只在指導寫了 {容器名} 的那一行才讀（正式站 Rails 教案：push、pop 那一行的 stack 圖晚一兩步才更新）。
import VisualizerHelper from "../VisualizerHelper";
import * as localEngine from "../localEngine";
import initialStoreData from "../InitialStoreData";
import { store } from "statorgfc";
import { global_variable } from "../global_variable";

jest.mock("../SourceCode", () => ({
  __esModule: true,
  default: { make_current_line_visible: jest.fn(() => true) },
}));
jest.mock("../process_gdb_response", () => ({ __esModule: true, default: jest.fn() }));

beforeAll(() => {
  // @ts-expect-error statorgfc's old declarations omit initialize.
  store.initialize({ ...initialStoreData }, { immutable: false, debounce_ms: 0 });
});

afterEach(() => {
  jest.restoreAllMocks();
  delete (global_variable as any).__latest_containers;
  delete (global_variable as any).__line;
});

/** 容器面板上目前畫著這些容器（內容不重要，只看名字）。 */
function drawn(...names: string[]) {
  (global_variable as any).__latest_containers = new Map(
    names.map((n) => [n, { name: n, type: "stack", values: [], isContainer: true }])
  );
}

describe("containers_to_refresh", () => {
  test("畫過、這一行指導沒提到、這一層求得到值的容器才重讀", () => {
    drawn("train", "order", "memo");
    const q = jest
      .spyOn(localEngine, "engineQuery")
      .mockImplementation((cmd: string) => ({ ok: !/ memo$/.test(cmd), payload: {} }));
    const content = VisualizerHelper.extractBalancedBraces("index={index} {order}");
    expect(VisualizerHelper.containers_to_refresh(content)).toEqual(["train"]);
    expect(q).toHaveBeenCalledWith("-data-evaluate-expression train");
    expect(q).not.toHaveBeenCalledWith("-data-evaluate-expression order"); // 指導自己的 token 會讀
  });

  test("帶索引或顏色的 token 也算提到（{memo[n]:orange} → memo）；沒畫過容器時不問引擎", () => {
    drawn("memo", "dp");
    jest.spyOn(localEngine, "engineQuery").mockReturnValue({ ok: true, payload: {} });
    const content = VisualizerHelper.extractBalancedBraces("{memo[n]:orange} {dp[i][j]:lime}");
    expect(VisualizerHelper.containers_to_refresh(content)).toEqual([]);
    (global_variable as any).__latest_containers = new Map();
    const q = jest.spyOn(localEngine, "engineQuery");
    expect(VisualizerHelper.containers_to_refresh([])).toEqual([]);
    expect(q).not.toHaveBeenCalled();
  });
});

describe("processing_guide", () => {
  test("沒有指導的行：只重讀畫過的容器（refreshOnly），指導欄不動", () => {
    drawn("train");
    jest.spyOn(localEngine, "engineQuery").mockReturnValue({ ok: true, payload: {} });
    const gi = jest.spyOn(VisualizerHelper, "graphics_instruction").mockResolvedValue(undefined as any);
    (global_variable as any).__line = { 26: "[進站{i}號#blue] {order}" };
    VisualizerHelper.processing_guide("29", "main");
    expect(gi).toHaveBeenCalledWith([], "29", "main", ["train"], true);
  });

  test("有指導的行：指導的 token 之外，把指導沒提到的容器一起交給 graphics_instruction", () => {
    drawn("train", "order");
    jest.spyOn(localEngine, "engineQuery").mockReturnValue({ ok: true, payload: {} });
    const gi = jest.spyOn(VisualizerHelper, "graphics_instruction").mockResolvedValue(undefined as any);
    (global_variable as any).__line = { 26: "[進站{i}號#blue] index={index} {order}" };
    VisualizerHelper.processing_guide("26", "main");
    expect(gi).toHaveBeenCalledTimes(1);
    const [content, , , refresh, refreshOnly] = gi.mock.calls[0] as any[];
    expect(content).toContain("{order}");
    expect(refresh).toEqual(["train"]);
    expect(refreshOnly).toBeUndefined();
  });

  test("沒畫過容器、這一行也沒有指導：什麼都不做", () => {
    const gi = jest.spyOn(VisualizerHelper, "graphics_instruction").mockResolvedValue(undefined as any);
    VisualizerHelper.processing_guide("29", "main");
    expect(gi).not.toHaveBeenCalled();
  });
});
