---
name: add-plugin
description: Scaffold a new container visualizer plugin. Use when adding support for a new STL container type (e.g. vector, stack, priority_queue).
argument-hint: "<ContainerType> [additional types...]"
---

Scaffold a new `ContainerPlugin` for the type(s): `$arguments`.

## Project context

```!
cd "c:/碩士/研究/papper/CPPcodeVisualizer" && echo "=== Existing plugins ===" && ls gdbgui/src/js/*Plugin.ts 2>/dev/null && echo "=== Registered in ContainerVisualizer ===" && grep "registerPlugin" gdbgui/src/js/ContainerVisualizer.tsx
```

## Steps

1. **Create `gdbgui/src/js/<Name>Plugin.ts`** implementing the `ContainerPlugin` interface:
   - `supportedTypes`: include all types from `$arguments`
   - `diffOps`: detect inserts and erases by diffing against internal history
   - `animateOp`: animate one op (at minimum a 300 ms highlight, then clear)
   - `prospectiveOp`: return `null` for now (can be added later)
   - `render`: return a React element showing the container's current state
   - `resetAll` / `resetContainer`: clear all internal state
   - Export a singleton `export const <name>Plugin = new <Name>Plugin()`

2. **Register** in `gdbgui/src/js/ContainerVisualizer.tsx`:
   - Import the new plugin
   - Call `registerPlugin(<name>Plugin)` at module load (alongside existing calls)

3. **Write tests** in `gdbgui/src/js/tests/<Name>Plugin.jest.ts`:
   - `diffOps — first encounter`: empty → [], non-empty → insert ops
   - `diffOps — subsequent`: same data → [], insert → insert op, erase → erase op
   - `animateOp`: resolves without hanging, calls requestRender
   - `resetAll` / `resetContainer`: state is cleared

4. **Run `/test`** and confirm all tests pass before finishing.

## Constraints
- The new plugin must NOT import from `ContainerVisualizer.tsx` (circular dependency).
- Use `React.createElement(...)` not JSX if the file is `.ts` (not `.tsx`).
- Do not modify `AnimScheduler.ts` or `ContainerPlugin.ts`.
