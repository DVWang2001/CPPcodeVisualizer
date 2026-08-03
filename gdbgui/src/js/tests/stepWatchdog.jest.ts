import {
  armStepWatchdog,
  clearStepWatchdog,
  stepWatchdogPending,
  STEP_WATCHDOG_MS,
} from "../stepWatchdog";

describe("stepWatchdog", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    clearStepWatchdog();
  });
  afterEach(() => {
    clearStepWatchdog();
    jest.useRealTimers();
  });

  it("正常步進：逾時前停下來就不通報", () => {
    const onWedged = jest.fn();
    let running = true;
    armStepWatchdog("下一步", { isStillRunning: () => running, onWedged }, 1000);

    running = false; // GDB 回報停駐
    clearStepWatchdog();
    jest.advanceTimersByTime(5000);

    expect(onWedged).not.toHaveBeenCalled();
    expect(stepWatchdogPending()).toBe(false);
  });

  it("計時器晚於停駐事件觸發時也不誤報", () => {
    const onWedged = jest.fn();
    let running = true;
    armStepWatchdog("下一步", { isStillRunning: () => running, onWedged }, 1000);

    // 沒有呼叫 clearStepWatchdog，但狀態已經不是 running——競態下的真實情況。
    running = false;
    jest.advanceTimersByTime(1000);

    expect(onWedged).not.toHaveBeenCalled();
  });

  it("卡死：逾時仍在 running 就通報，並帶出命令與秒數", () => {
    const onWedged = jest.fn();
    armStepWatchdog("步入", { isStillRunning: () => true, onWedged }, 30_000);

    jest.advanceTimersByTime(29_999);
    expect(onWedged).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    expect(onWedged).toHaveBeenCalledWith("步入", 30);
  });

  it("只通報一次，不會反覆觸發", () => {
    const onWedged = jest.fn();
    armStepWatchdog("下一步", { isStillRunning: () => true, onWedged }, 1000);

    jest.advanceTimersByTime(10_000);

    expect(onWedged).toHaveBeenCalledTimes(1);
    expect(stepWatchdogPending()).toBe(false);
  });

  it("連續步進：後一次取代前一次，不會留下舊計時器", () => {
    const onWedged = jest.fn();
    const deps = { isStillRunning: () => true, onWedged };
    armStepWatchdog("下一步", deps, 1000);
    armStepWatchdog("下一步", deps, 1000);
    armStepWatchdog("下一步", deps, 1000);

    jest.advanceTimersByTime(1000);

    expect(onWedged).toHaveBeenCalledTimes(1);
  });

  it("預設逾時是 30 秒 —— 單一步進遠用不到，但容得下慢函式", () => {
    expect(STEP_WATCHDOG_MS).toBe(30_000);
  });
});
