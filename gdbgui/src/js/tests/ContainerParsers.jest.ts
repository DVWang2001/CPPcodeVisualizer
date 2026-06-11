// ContainerParsers.jest.ts
// Unit tests for containerParsers/ — each parser takes a plain varObj and context;
// no store mocking needed except for InnerContainerParser which writes back numchild.

import StringParser from "../containerParsers/StringParser";
import DefaultParser from "../containerParsers/DefaultParser";
import MapParser from "../containerParsers/MapParser";
import ArrayParser from "../containerParsers/ArrayParser";
import InnerContainerParser from "../containerParsers/InnerContainerParser";
import { resolveChildValues } from "../containerParsers/index";

// ── helpers ──────────────────────────────────────────────────────────────────

const mockFetch = jest.fn();
const mockCreate = jest.fn();
const mockStoreGet = jest.fn().mockReturnValue([]);
const mockStoreSet = jest.fn();

const makeContext = (containerName = "array", expressions: any[] = []) => ({
  trimmedInst: "a",
  expressions,
  GdbVariable: {
    fetch_and_show_children_for_var: mockFetch,
    create_variable: mockCreate,
  },
  containerName,
  store: { get: mockStoreGet, set: mockStoreSet },
});

const accessChild = (children: any[] = [], opts: any = {}) => ({
  exp: "public",
  value: "",
  numchild: children.length,
  children,
  show_children_in_ui: false,
  ...opts,
});

const melemsChild = (children: any[] = [], opts: any = {}) => ({
  exp: "_M_elems",
  type: "std::__array_traits<int, 3>::_Type",
  numchild: children.length,
  value: children.length === 0 ? "[3]" : undefined,
  children,
  show_children_in_ui: false,
  name: "var3.public._M_elems",
  ...opts,
});

const intElem = (v: string) => ({ value: v, type: "int" });

beforeEach(() => {
  jest.clearAllMocks();
  mockStoreGet.mockReturnValue([]);
});

// ─────────────────────────────────────────────────────────────────────────────
// StringParser
// ─────────────────────────────────────────────────────────────────────────────

describe("StringParser", () => {
  const p = new StringParser();

  it("canHandle only 'string'", () => {
    expect(p.canHandle("string", {} as any)).toBe(true);
    expect(p.canHandle("vector", {} as any)).toBe(false);
  });

  it("S1: quoted string splits into chars", () => {
    const r = p.parse({ value: '"hi"' } as any, makeContext("string"));
    expect(r).toEqual({ done: true, values: ["h", "i"] });
  });

  it("S2: empty quoted string gives []", () => {
    const r = p.parse({ value: '""' } as any, makeContext("string"));
    expect(r).toEqual({ done: true, values: [] });
  });

  it("S3: unquoted string splits into chars", () => {
    const r = p.parse({ value: "hello" } as any, makeContext("string"));
    expect(r).toEqual({ done: true, values: ["h", "e", "l", "l", "o"] });
  });

  it("S4: undefined value gives []", () => {
    const r = p.parse({ value: undefined } as any, makeContext("string"));
    expect(r).toEqual({ done: true, values: [] });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DefaultParser
// ─────────────────────────────────────────────────────────────────────────────

describe("DefaultParser", () => {
  const p = new DefaultParser();

  it("canHandle always returns true", () => {
    expect(p.canHandle("anything", {} as any)).toBe(true);
    expect(p.canHandle("deque", { children: [] } as any)).toBe(true);
  });

  it("D1: returns children values", () => {
    const varObj = { children: [{ value: "a" }, { value: "b" }, { value: "c" }] };
    expect(p.parse(varObj as any, makeContext())).toEqual({
      done: true,
      values: ["a", "b", "c"],
    });
  });

  it("D2: empty children gives []", () => {
    expect(p.parse({ children: [] } as any, makeContext())).toEqual({
      done: true,
      values: [],
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MapParser
// ─────────────────────────────────────────────────────────────────────────────

describe("MapParser", () => {
  const p = new MapParser();

  it("canHandle map and unordered_map", () => {
    expect(p.canHandle("map", {} as any)).toBe(true);
    expect(p.canHandle("unordered_map", {} as any)).toBe(true);
    expect(p.canHandle("set", {} as any)).toBe(false);
  });

  it("M1: new GDB flat alternating format", () => {
    const varObj = {
      children: [
        { value: "1" }, { value: "a" },
        { value: "2" }, { value: "b" },
      ],
    };
    expect(p.parse(varObj as any, makeContext("map"))).toEqual({
      done: true,
      values: [
        { key: "1", value: "a" },
        { key: "2", value: "b" },
      ],
    });
  });

  it("M2: old GDB {first, second} format", () => {
    const varObj = {
      children: [
        { value: "{first = 1, second = a}", expression: "0" },
        { value: "{first = 2, second = b}", expression: "1" },
      ],
    };
    const r = p.parse(varObj as any, makeContext("map"));
    expect(r.done).toBe(true);
    expect(r.values).toEqual([
      { key: "1", value: "a" },
      { key: "2", value: "b" },
    ]);
  });

  it("M3: quoted value string stripped of quotes", () => {
    const varObj = {
      children: [{ value: "42" }, { value: '"hello"' }],
    };
    const r = p.parse(varObj as any, makeContext("map"));
    expect(r).toEqual({
      done: true,
      values: [{ key: "42", value: "hello" }],
    });
  });

  it("M4: empty map gives []", () => {
    const r = p.parse({ children: [] } as any, makeContext("map"));
    expect(r).toEqual({ done: true, values: [] });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ArrayParser
// ─────────────────────────────────────────────────────────────────────────────

describe("ArrayParser", () => {
  const p = new ArrayParser();

  it("canHandle only 'array'", () => {
    expect(p.canHandle("array", {} as any)).toBe(true);
    expect(p.canHandle("vector", {} as any)).toBe(false);
  });

  it("A1: pretty-printer present — children are elements directly", () => {
    const varObj = {
      children: [intElem("1"), intElem("2"), intElem("3")],
    };
    expect(p.parse(varObj as any, makeContext())).toEqual({
      done: true,
      values: ["1", "2", "3"],
    });
  });

  it("A2: struct layout — _M_elems children already loaded", () => {
    const varObj = {
      value: "{_M_elems = {1, 2, 3}}",
      children: [
        accessChild([melemsChild([intElem("1"), intElem("2"), intElem("3")])]),
      ],
    };
    expect(p.parse(varObj as any, makeContext())).toEqual({
      done: true,
      values: ["1", "2", "3"],
    });
  });

  it("A3: _M_elems not yet fetched — triggers fetch, returns done:false", () => {
    const elems = melemsChild([], { numchild: 3, show_children_in_ui: false });
    const varObj = {
      value: "{_M_elems = {1, 2, 3}}",
      children: [accessChild([elems])],
    };
    const r = p.parse(varObj as any, makeContext());
    expect(r.done).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(elems.name);
  });

  it("A4: _M_elems already in-flight (show_children_in_ui=true) — guard prevents double-fetch", () => {
    const elems = melemsChild([], { numchild: 3, show_children_in_ui: true });
    const varObj = {
      value: "{_M_elems = {1, 2, 3}}",
      children: [accessChild([elems])],
    };
    const r = p.parse(varObj as any, makeContext());
    expect(r.done).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled(); // guard held
  });

  it("A5: public section not yet fetched — triggers fetch", () => {
    const pub = accessChild([], { numchild: 1, show_children_in_ui: false, name: "var3.public" });
    const varObj = { value: "{_M_elems = {1, 2, 3}}", children: [pub] };
    const r = p.parse(varObj as any, makeContext());
    expect(r.done).toBe(false);
    expect(mockFetch).toHaveBeenCalledWith(pub.name);
  });

  it("A6: _M_elems numchild=0, value='[3]' → falls back to varObj.value", () => {
    const elems = melemsChild([], { numchild: 0, value: "[3]" });
    const varObj = {
      value: "{_M_elems = {1, 2, 3}}",
      children: [accessChild([elems])],
    };
    expect(p.parse(varObj as any, makeContext())).toEqual({
      done: true,
      values: ["1", "2", "3"],
    });
  });

  it("A7: inner is empty (no _M_elems found) — returns []", () => {
    const varObj = {
      value: "{}",
      children: [accessChild([])],
    };
    expect(p.parse(varObj as any, makeContext())).toEqual({
      done: true,
      values: [],
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// InnerContainerParser
// ─────────────────────────────────────────────────────────────────────────────

describe("InnerContainerParser", () => {
  const p = new InnerContainerParser();

  const innerChild = (opts: any = {}) => ({
    value: "deque of length 2, capacity 512",
    type: "std::deque<int>",
    numchild: NaN,
    children: [],
    name: "var_inner",
    ...opts,
  });

  it("canHandle when a child has inner container type", () => {
    const varObj = { children: [innerChild()] };
    expect(p.canHandle("queue", varObj as any)).toBe(true);
  });

  it("canHandle false when no inner container children", () => {
    const varObj = { children: [{ value: "9", type: "int" }] };
    expect(p.canHandle("deque", varObj as any)).toBe(false);
  });

  it("I1: inner child not yet loaded — triggers fetch, returns done:false", () => {
    const child = innerChild();
    const varObj = { children: [child] };
    const ctx = makeContext("queue");
    const r = p.parse(varObj as any, ctx);
    expect(r.done).toBe(false);
    expect(r.retryMs).toBe(200);
    expect(mockFetch).toHaveBeenCalledWith(child.name);
  });

  it("I2: inner child already loaded — returns values", () => {
    const child = innerChild({
      numchild: 2,
      children: [{ value: "9" }, { value: "10" }],
    });
    const varObj = { children: [child] };
    // Non-queue container: nested array
    const r = p.parse(varObj as any, makeContext("list"));
    expect(r.done).toBe(true);
    expect(r.values).toEqual([["9", "10"]]);
  });

  it("I3: queue single-wrapper flattened to flat array", () => {
    const child = innerChild({
      numchild: 2,
      children: [{ value: "7" }, { value: "8" }],
    });
    const varObj = { children: [child] };
    const r = p.parse(varObj as any, makeContext("queue"));
    expect(r.done).toBe(true);
    expect(r.values).toEqual(["7", "8"]); // flattened
  });

  it("I4: empty inner container gives nested []", () => {
    const child = innerChild({ value: "vector of length 0", numchild: 0 });
    const varObj = { children: [child] };
    const r = p.parse(varObj as any, makeContext("list"));
    expect(r.done).toBe(true);
    expect(r.values).toEqual([[]]); // one empty sub-array
  });

  it("I5: NaN numchild is patched from 'of length N' before fetch", () => {
    const child = innerChild({ value: "deque of length 3, capacity 512" });
    const varObj = { children: [child] };
    p.parse(varObj as any, makeContext("queue"));
    // numchild written back via in-place mutation — no store.set needed
    expect(child.numchild).toBe(3);
    expect(mockStoreSet).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveChildValues — chain integration
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveChildValues (chain)", () => {
  it("routes 'string' to StringParser", () => {
    const r = resolveChildValues("string", { value: '"ab"' } as any, makeContext("string"));
    expect(r).toEqual({ done: true, values: ["a", "b"] });
  });

  it("routes 'map' to MapParser", () => {
    const varObj = { children: [{ value: "1" }, { value: "z" }] };
    const r = resolveChildValues("map", varObj as any, makeContext("map"));
    expect(r).toEqual({ done: true, values: [{ key: "1", value: "z" }] });
  });

  it("routes 'array' to ArrayParser", () => {
    const varObj = { children: [intElem("5"), intElem("6")] };
    const r = resolveChildValues("array", varObj as any, makeContext("array"));
    expect(r).toEqual({ done: true, values: ["5", "6"] });
  });

  it("falls back to DefaultParser for unknown containers", () => {
    const varObj = { children: [{ value: "x" }, { value: "y" }] };
    const r = resolveChildValues("set", varObj as any, makeContext("set"));
    expect(r).toEqual({ done: true, values: ["x", "y"] });
  });

  it("InnerContainerParser takes precedence over DefaultParser when inner children present", () => {
    const child = {
      value: "deque of length 2, capacity 512",
      type: "std::deque<int>",
      numchild: 2,
      children: [{ value: "9" }, { value: "10" }],
    };
    const varObj = { children: [child] };
    const r = resolveChildValues("queue", varObj as any, makeContext("queue"));
    expect(r).toEqual({ done: true, values: ["9", "10"] });
  });
});
