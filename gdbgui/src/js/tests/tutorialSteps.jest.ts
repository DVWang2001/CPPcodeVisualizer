import { stepState, nextStep, prevStep } from "../tutorialSteps";

test("stepState: before = done, at = now, after = upcoming", () => {
  expect([0, 1, 2].map(i => stepState(i, 1))).toEqual(["done", "now", "upcoming"]);
  expect([0, 1, 2].map(i => stepState(i, 3))).toEqual(["done", "done", "done"]); // 整課做完
  expect([0, 1, 2].map(i => stepState(i, 0))).toEqual(["now", "upcoming", "upcoming"]);
});

test("nextStep stops at n (finished), prevStep at 0", () => {
  expect(nextStep(0, 3)).toBe(1);
  expect(nextStep(2, 3)).toBe(3);
  expect(nextStep(3, 3)).toBe(3);
  expect(prevStep(3)).toBe(2);
  expect(prevStep(0)).toBe(0);
});
