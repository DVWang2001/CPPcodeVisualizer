// GDB variable objects (S4 minimal set) over the recorded trace.
//
// Supported: a plain variable name whose type is int-family / bool / char / float / double /
// std::string, std::vector/deque/list/stack/queue/priority_queue<T>, std::set/multiset/unordered_(multi)set<K>,
// std::map/multimap/unordered_(multi)map<K,V> (element/key/value types recursively supported), or a
// reference to any of those. Anything else (pointers other than `this`, structs, arrays, arithmetic,
// `&x`, `x[i]`, member calls) gets an explicit MI error; `name.method()` gets the error real GDB gives
// for the libstdc++ methods the UI probes (`Cannot evaluate function -- may be inlined`).
//
// Mirrors what the golden sample shows (spec §5): auto names var1, var2, ... (the counter also advances
// when the create fails), vectors are dynamic varobjs with displayhint "array" and children
// `name.[i]`, `numchild` is "0" until the children were listed, `-var-update` walks the roots newest
// first and reports value changes, `in_scope:"false"` when the varobj's block is left and the value
// again when it is re-entered.
// Plain ES module, no DOM / Node APIs.

import { classify, gdbType, isSupported, isDynamic, isSimple, FLAT_CONTAINER_KINDS } from "./types.js";
import { valueOf } from "./model.js";
import { printValue } from "./types.js";
import { resultItem, errorItem, unsupportedMsg } from "./mi.js";
import { parseExpr, evalAst, collectNames, resultClass, rawOf } from "./expr.js";

/** @param {any} node */
const pointerTo = (node) => ({ k: "p", to: node });

const own = (/** @type {object} */ o, /** @type {string} */ k) => Object.prototype.hasOwnProperty.call(o, k);

/**
 * Unwraps a reference, or a pointer SPECIFICALLY to a class (`this`, or any `Class*` local) — for
 * BOTH, GDB's C++ varobj support skips an intermediate "pointee" node and shows the class's access
 * pseudo-nodes as direct children (confirmed against a real `gdb -i mi -enable-pretty-printing`
 * session for both a `const Acc&` parameter and `this` inside a member function). A pointer to
 * anything else stays as-is (still unsupported — see isSupported in types.js, which only allows
 * "ptr" when its pointee is "class"). Only for numchild/children dispatch — `_value()` special-cases
 * these two directly instead, since their VALUE strings differ (a class value's own "{...}"; a
 * reference's is also "{...}" at var-create but a bare address at evaluate(); a pointer's is always
 * its own pseudo-address — see the comments in `_value` and `evaluate`).
 * @param {any} cls
 */
const childKind = (cls) => (cls.kind === "ref" ? cls.to : cls.kind === "ptr" && cls.to && cls.to.kind === "class" ? cls.to : cls);

/**
 * `this` is the ONE pointer-to-class expression with real backing data (vg.h traces it dereferenced
 * — see instrument.js's probe() — every other pointer, including a `Point* p` local, is still traced
 * as the opaque generic placeholder). isSupported() stays type-only and conservative (a bare
 * `Class*` type is NOT supported in general — widening it there previously let any Class* through
 * `-var-create` and silently showed wrong data, even a non-null address for a null pointer); this
 * checks the actual EXPRESSION text instead, and only "this" (a C++ keyword — no real variable can
 * ever be named it) qualifies.
 *
 * The pointee class must ALSO be fully isSupported() in its own right — not just "some class" — or
 * this exception reopens the exact hole it closes one level down: a self-referential class (a
 * linked-list or BST node, `struct Node { Node* next; }`) is not isSupported (a raw pointer FIELD
 * stays unsupported, same as any other raw pointer), but `this` used to get through regardless of
 * that; expanding it then expanded `next` too — childKind()'s ptr-to-class unwrap is purely
 * type-based, with no way to tell "this is the real `this`" apart from "this is some field reached
 * through it" — showing `next`'s made-up placeholder data (a null pointer even looked non-null,
 * since the pseudo-address branch in _value()/evaluate() doesn't know the difference either).
 * Requiring the pointee to be fully supported means `this` inside a self-referential class's own
 * method is consistently rejected too, matching what a plain `Node` value or `Node&` already gets —
 * not a new limitation, just consistency with the boundary this whole feature already has (no
 * pointer-chasing/traversal support in phase 1).
 * @param {string} e @param {any} cls
 */
const isThisPtr = (e, cls) => e === "this" && cls.kind === "ptr" && cls.to && cls.to.kind === "class" && isSupported(cls.to);

/**
 * @typedef {{ name: string, exp: string, parent: VarObj | null, index: number, ti: any, children: VarObj[] | null,
 *   root: VarObj, varName: string, frameId: number | null, fn: string, blockId: number, global: boolean,
 *   lastValue: string | null, lastInScope: boolean, addrName: string, kind?: "var" | "expr" | "ptr" | "ptrchild" | "basechild" | "elem" | "access" | "classfield",
 *   ast?: any, pointee?: any, fieldName?: string }} VarObj
 */

export class VarObjs {
  /** @param {{ model: import("./model.js").TraceModel, exec: import("./exec.js").ExecState }} host */
  constructor(host) {
    this.host = host;
    /** @type {Map<string, VarObj>} */
    this.byName = new Map();
    /** @type {VarObj[]} roots in creation order */
    this.roots = [];
    this.counter = 0;
    this._ck = "";
    /** @type {import("./model.js").FrameRec[]} */ this._cc = [];
    /** @type {Map<number, import("./model.js").FrameRec>} */ this._cm = new Map();
  }

  reset() { this.byName.clear(); this.roots = []; this.counter = 0; }

  get _model() { return this.host.model; }
  /** Frame chain of the current display position (cached per position). @returns {import("./model.js").FrameRec[]} */
  _frames() {
    const ex = this.host.exec;
    const key = `${ex.pos}|${ex.disp}|${ex.landed}|${ex.running}`;
    if (this._ck !== key) {
      const idx = ex.landed ? ex.disp : ex.pos;
      this._cc = ex.running && idx >= 0 && idx < this._model.steps.length ? this._model.chain(idx) : [];
      this._cm = new Map(this._cc.map((f) => [f.frameId, f]));
      this._ck = key;
    }
    return this._cc;
  }

  /** Trace step index a frame currently executes, or -1 when the frame is not on the stack. @param {number | null} frameId */
  _frameStep(frameId) {
    this._frames();
    const f = frameId === null ? null : this._cm.get(frameId);
    return f ? f.stepIdx : -1;
  }

  /**
   * @param {string} nameArg `-` for auto naming
   * @param {string} expr
   * @param {number | null} token
   */
  create(nameArg, expr, token) {
    const auto = nameArg === "-" || nameArg === "";
    let name = nameArg;
    if (auto) name = "var" + ++this.counter;
    else if (this.byName.has(name)) return errorItem(`Duplicate variable object name`, token);
    const e = expr.trim();
    if (/^[A-Za-z_]\w*\s*\.\s*[A-Za-z_]\w*\s*\(.*\)$/.test(e)) return errorItem("Cannot evaluate function -- may be inlined", token);
    const am = /^&\s*\(?\s*([A-Za-z_]\w*)\s*\)?$/.exec(e);
    if (am) return this._createPtr(name, e, am[1], token);
    if (!/^[A-Za-z_]\w*$/.test(e) || e === "true" || e === "false") return this._createExpr(name, e, token);
    const r = this._resolve(e);
    if ("error" in r) return errorItem(r.error, token);
    const cls = r.cls;
    if (!isSupported(cls) && !isThisPtr(e, cls)) return errorItem(unsupportedMsg(`type '${r.gdbType}'`), token);
    /** @type {VarObj} */
    const vo = {
      name, exp: e, parent: null, index: -1, kind: "var", ti: { cls, node: r.node, gdbType: r.gdbType }, children: null,
      root: /** @type {any} */ (null), varName: e, frameId: r.frameId, fn: r.fn, blockId: r.blockId, global: r.global,
      lastValue: null, lastInScope: true, addrName: e,
    };
    vo.root = vo;
    this.byName.set(name, vo);
    this.roots.push(vo);
    vo.lastValue = this._value(vo);
    return resultItem(this._describe(vo, true), token);
  }

  /** Lookup function of the frame a varobj expression lives in. @param {number | null} frameId */
  _lookup(frameId) {
    const model = this._model;
    const si = frameId === null ? -1 : this._frameStep(frameId);
    const ents = si >= 0 ? model.visibleVars(si) : [];
    const cur = this.host.exec;
    const gi = Math.min(Math.max(cur.landed ? cur.disp : cur.pos, 0), model.steps.length - 1);
    return (/** @type {string} */ n) => {
      const e = ents.find((x) => x.name === n);
      if (e) return { cls: e.cls, raw: e.raw };
      if (own(model.globals, n)) {
        const ti = model.typeInfo(model.globals[n]);
        const s = model.steps[si >= 0 ? si : gi];
        return { cls: ti.cls, raw: s && own(s.vars, n) ? s.vars[n] : 0 };
      }
      return null;
    };
  }

  /** `-var-create` of an arithmetic / subscript expression (`w - 1`, `dp[r][j + 1]`). @param {string} name @param {string} e @param {number | null} token */
  _createExpr(name, e, token) {
    let ast;
    try { ast = parseExpr(e); } catch (x) { return errorItem(/** @type {any} */ (x).message, token); }
    const ex = this.host.exec, model = this._model;
    const frames = this._frames();
    const fr = frames[Math.min(ex.selectedLevel, frames.length - 1)];
    const names = [...collectNames(ast)].filter((n) => n !== "true" && n !== "false");
    // block: the innermost block among the local variables the expression uses (GDB: innermost_block)
    let blockId = -1, depth = -1, hasLocal = false;
    if (fr) {
      const sc = model.scopes.get(fr.fn);
      const ents = model.visibleVars(fr.stepIdx);
      for (const n of names) {
        const ent = ents.find((v) => v.name === n);
        if (!ent) continue;
        hasLocal = true;
        const d = sc ? sc.blocks[ent.blockId].depth : 0;
        if (d > depth) { depth = d; blockId = ent.blockId; }
      }
    }
    let val;
    try { val = evalAst(ast, this._lookup(fr ? fr.frameId : null)); } catch (x) { return errorItem(/** @type {any} */ (x).message, token); }
    const rc = resultClass(val);
    if (!rc) return errorItem(unsupportedMsg(`expression '${e}' (its value is a container)`), token);
    /** @type {VarObj} */
    const vo = {
      name, exp: e, parent: null, index: -1, kind: "expr", ast, ti: { cls: rc.cls, node: rc.cls.node, gdbType: rc.name }, children: null,
      root: /** @type {any} */ (null), varName: e, frameId: hasLocal && fr ? fr.frameId : null, fn: hasLocal && fr ? fr.fn : "", blockId,
      global: !hasLocal, lastValue: null, lastInScope: true, addrName: e,
    };
    vo.root = vo;
    this.byName.set(name, vo);
    this.roots.push(vo);
    vo.lastValue = this._value(vo);
    return resultItem(this._describe(vo, true), token);
  }

  /** `-var-create` of `&(name)`: a pointer varobj (golden: numchild "1", one child `*&(name)`). @param {string} name @param {string} e @param {string} target @param {number | null} token */
  _createPtr(name, e, target, token) {
    const r = this._resolve(target);
    if ("error" in r) return errorItem(r.error, token);
    const pc = r.cls.kind === "ref" ? r.cls.to : r.cls;
    const scalar = pc.kind === "int" || pc.kind === "bool" || pc.kind === "char" || pc.kind === "float";
    if (!(scalar || ((pc.kind === "vector" || pc.kind === "array") && isSupported(pc)))) return errorItem(unsupportedMsg(`type '${gdbType(pointerTo(r.node))}'`), token);
    const pnode = r.cls.kind === "ref" ? r.node.to : r.node;
    /** @type {VarObj} */
    const vo = {
      name, exp: e, parent: null, index: -1, kind: "ptr", ti: { cls: { kind: "ptr", node: pointerTo(pnode) }, node: pointerTo(pnode), gdbType: gdbType(pointerTo(pnode)) },
      pointee: { cls: pc, node: pnode, gdbType: gdbType(pnode) }, children: null, root: /** @type {any} */ (null),
      varName: target, frameId: r.frameId, fn: r.fn, blockId: r.blockId, global: r.global, lastValue: null, lastInScope: true, addrName: target,
    };
    vo.root = vo;
    this.byName.set(name, vo);
    this.roots.push(vo);
    vo.lastValue = this._value(vo);
    return resultItem(this._describe(vo, true), token);
  }

  /** Children of a pointer varobj: the pointee (scalar) or the vector's `_Vector_base` (golden). @param {VarObj} vo */
  _ptrChildren(vo) {
    if (vo.children) return vo.children;
    const pe = /** @type {any} */ (vo.pointee);
    /** @type {VarObj} */
    let c;
    if (pe.cls.kind === "vector") {
      const E = gdbType(pe.cls.elem, true);
      const al = `std::allocator<${E}${E.endsWith(">") ? " " : ""}>`;
      const T = `std::_Vector_base<${E}, ${al} >`;
      c = { name: `${vo.name}.${T}`, exp: T, parent: vo, index: 0, kind: "basechild", ti: { cls: { kind: "other", node: pe.node }, node: pe.node, gdbType: T }, children: null,
        root: vo.root, varName: vo.varName, frameId: vo.frameId, fn: vo.fn, blockId: vo.blockId, global: vo.global, lastValue: "{...}", lastInScope: true, addrName: vo.addrName };
    } else {
      c = { name: `${vo.name}.*${vo.exp}`, exp: `*${vo.exp}`, parent: vo, index: 0, kind: "ptrchild", ti: { cls: pe.cls, node: pe.node, gdbType: pe.gdbType }, children: null,
        root: vo.root, varName: vo.varName, frameId: vo.frameId, fn: vo.fn, blockId: vo.blockId, global: vo.global, lastValue: null, lastInScope: true, addrName: vo.addrName };
      c.lastValue = this._value(c);
    }
    vo.children = [c];
    this.byName.set(c.name, c);
    return vo.children;
  }

  /** @param {string} e @returns {any} */
  _resolve(e) {
    const model = this._model, ex = this.host.exec;
    const frames = this._frames();
    const fr = frames[Math.min(ex.selectedLevel, frames.length - 1)];
    if (fr) {
      const entries = model.visibleVars(fr.stepIdx);
      const ent = entries.find((v) => v.name === e);
      if (ent) return { cls: ent.cls, node: ent.node, gdbType: ent.gdbType, frameId: fr.frameId, fn: fr.fn, blockId: ent.blockId, global: false };
    }
    if (own(model.globals, e)) {
      const ti = model.typeInfo(model.globals[e]);
      return { cls: ti.cls, node: ti.node, gdbType: ti.gdbType, frameId: null, fn: "", blockId: -1, global: true };
    }
    return { error: fr ? `No symbol "${e}" in current context.` : "No frame selected." };
  }

  /** value of the root variable in its frame (raw trace value) @param {VarObj} vo */
  _rawRoot(vo) {
    const model = this._model;
    if (vo.global) {
      const ex = this.host.exec;
      const i = Math.min(Math.max(ex.landed ? ex.disp : ex.pos, 0), model.steps.length - 1);
      const s = model.steps[i];
      return s && own(s.vars, vo.varName) ? s.vars[vo.varName] : 0;
    }
    const si = this._frameStep(vo.frameId);
    if (si < 0) return undefined;
    const s = model.steps[si];
    if (own(s.vars, vo.varName)) return s.vars[vo.varName];
    const k = vo.ti.cls.kind;
    return k === "vector" || k === "map" || FLAT_CONTAINER_KINDS.has(k) ? [] : k === "string" ? "" : k === "class" ? {} : 0;
  }

  /** @param {VarObj} vo */
  _raw(vo) {
    if (vo.kind === "expr") {
      try { return rawOf(evalAst(vo.ast, this._lookup(vo.frameId))); } catch (x) { return undefined; }
    }
    if (vo.kind === "ptrchild") return this._rawRoot(/** @type {VarObj} */ (vo.parent));
    // An access pseudo-node (public/private/protected) has no data of its own — it is a synthetic
    // grouping GDB's C++ varobj support inserts, one layer above the real fields (see the class
    // README note). Pass its parent's raw object straight through so a field one level below can
    // index it by name.
    if (vo.kind === "access") return this._raw(/** @type {VarObj} */ (vo.parent));
    if (vo.kind === "classfield") {
      const pr = this._raw(/** @type {VarObj} */ (vo.parent));
      return pr && typeof pr === "object" ? pr[/** @type {string} */ (vo.fieldName)] : undefined;
    }
    if (!vo.parent) return this._rawRoot(vo);
    const pr = this._raw(vo.parent);
    if (!Array.isArray(pr)) return undefined;
    // A map's raw value is [[k1,v1],[k2,v2],...] but its children are FLAT and alternating
    // (key,value,key,value,...) — see _ensureMapChildren — so a child's index must be unflattened
    // back into a pair index + which half, not used to index pr directly like every other flat
    // container's children do.
    const pcls = /** @type {VarObj} */ (vo.parent).ti.cls;
    const pecls = pcls.kind === "ref" ? pcls.to : pcls;
    if (pecls.kind === "map") {
      const pair = pr[vo.index >> 1];
      return Array.isArray(pair) ? pair[vo.index & 1] : undefined;
    }
    return pr[vo.index];
  }

  /** @param {VarObj} vo */
  _capacityOf(vo) {
    if (vo.parent) { const r = this._raw(vo); return Array.isArray(r) ? r.length : 0; }
    const si = this._frameStep(vo.frameId);
    const s = si >= 0 ? this._model.steps[si] : null;
    const c = s && own(s.vars, vo.varName + ".capacity()") ? s.vars[vo.varName + ".capacity()"] : undefined;
    const r = this._rawRoot(vo);
    return typeof c === "number" ? c : Array.isArray(r) ? r.length : 0;
  }

  /** @param {VarObj} vo @returns {string} */
  _value(vo) {
    if (vo.kind === "ptr") return "0x" + this._model.varAddr(vo.frameId ?? 0, vo.varName).toString(16);
    if (vo.kind === "basechild") return "{...}";
    if (vo.kind === "access") return ""; // GDB's own access pseudo-nodes always report an empty value
    if (vo.kind === "expr") {
      try { return valueOf(vo.ti.cls, rawOf(evalAst(vo.ast, this._lookup(vo.frameId)))); } catch (x) { return `<error: ${/** @type {any} */ (x).message}>`; }
    }
    const cls = vo.ti.cls;
    // A pointer specifically to a class (this, or any Class* local) shows its own pseudo-address as
    // the value, like &(name) does — ground truth: real GDB's var-create value for `this` is a
    // plain address, never "{...}" (that generic-pointer placeholder is for OTHER pointer kinds,
    // which stay unsupported and never reach this far).
    if (cls.kind === "ptr" && cls.to && cls.to.kind === "class") return "0x" + this._model.varAddr(vo.frameId ?? 0, vo.varName).toString(16);
    const ecls = cls.kind === "ref" ? cls.to : cls;
    const raw = this._raw(vo);
    const s = valueOf(ecls, raw, ecls.kind === "vector" ? this._capacityOf(vo) : undefined);
    // A class reference's var-create value is the class's own "{...}", not the usual `@addr: value`
    // scalar-reference wrap (ground truth: a `const Acc&` parameter's var-create value is exactly
    // "{...}" with no address at all — only -data-evaluate-expression on one shows a bare address;
    // see evaluate()).
    if (cls.kind === "ref" && ecls.kind !== "class") return `@0x${this._model.varAddr(vo.frameId ?? 0, vo.varName).toString(16)}: ${s}`;
    return s;
  }

  /** In scope = the varobj's frame is on the stack and its pc is inside the block the varobj was created in (GDB: contained_in(get_selected_block, valid_block)). @param {VarObj} vo @returns {boolean} */
  _inScope(vo) {
    const r = vo.root;
    if (r.global) return true;
    const si = this._frameStep(r.frameId);
    if (si < 0) return false;
    const sc = this._model.scopes.get(r.fn);
    const b = sc && sc.blocks[r.blockId];
    if (!b) return true;
    const line = this._model.steps[si].line;
    return b.start <= line && line <= b.end;
  }

  /** @param {VarObj} vo @param {boolean} isCreate @returns {any} */
  _describe(vo, isCreate) {
    if (vo.kind === "access") {
      // GDB's own access pseudo-node shape: numchild = real fields at this access level (static,
      // known up front — a class layout can't change at runtime), empty value, no `type` key at all.
      const p = { name: vo.name, numchild: String(/** @type {any} */ (vo.ti.cls).fields.length), value: "" };
      if (!vo.root.global) /** @type {any} */ (p)["thread-id"] = "1";
      if (isCreate) /** @type {any} */ (p).has_more = "0";
      return p;
    }
    const cls = vo.ti.cls;
    const ecls = childKind(cls);
    // numchild: pointers 1; C arrays N (static type, known at creation); a class instance (or a
    // reference/this-pointer to one — childKind unwraps both) = its number of DISTINCT access
    // levels that have a field (not its field count — see access nodes, above); dynamic
    // (pretty-printed) ones: children listed so far.
    const nc = vo.kind === "ptr" || vo.kind === "basechild" ? "1"
      : ecls.kind === "array" ? String(ecls.n)
      : ecls.kind === "class" ? String(new Set(ecls.fields.map((/** @type {any} */ f) => f.access)).size)
      : String(vo.children ? vo.children.length : 0);
    const p = { name: vo.name, numchild: nc, value: this._value(vo), type: vo.ti.gdbType };
    if (!vo.root.global) /** @type {any} */ (p)["thread-id"] = "1";
    if (isDynamic(ecls)) {
      // GDB's list/set printers set no displayhint at all; map gets its own "map" hint (flat
      // alternating key/value children — see _ensureMapChildren); everything else dynamic is "array"
      // (or "string" for std::string). Confirmed against a real `gdb -i mi -enable-pretty-printing` session.
      if (ecls.kind === "map") /** @type {any} */ (p).displayhint = "map";
      else if (ecls.kind !== "list" && ecls.kind !== "set") /** @type {any} */ (p).displayhint = ecls.kind === "string" ? "string" : "array";
      /** @type {any} */ (p).dynamic = "1";
    }
    if (isCreate) /** @type {any} */ (p).has_more = this._hasMore(vo, ecls);
    return p;
  }

  /**
   * `has_more`: whether this varobj currently has any children to list. `vector` is unconditionally
   * "1" (GDB quirk, even when empty); every other dynamic container (map + the FLAT_CONTAINER_KINDS
   * family: deque/list/stack/queue/pqueue/set) is conditional on current emptiness — confirmed against
   * a real `gdb -i mi -enable-pretty-printing` session, INCLUDING on `-var-update` after a container
   * grows from empty (real GDB reports `has_more:"1"` there too, not just at `-var-create`). This must
   * stay in sync between `_describe()` (create) and `update()` (every subsequent stop): the frontend
   * (`GdbVariable.tsx`) uses a create-time `has_more` of "0" as its ONLY initial "nothing to show yet"
   * signal for a dynamic varobj (real GDB's `numchild` is always "0" for these until listed), and later
   * only re-fetches children when a `-var-update` changelist entry reports `has_more:"1"` — a container
   * that starts empty and is hardcoded to always report "0" here would look permanently empty in the
   * UI even after real inserts, since nothing would ever prompt a first `-var-list-children` call.
   * @param {VarObj} vo @param {any} ecls
   */
  _hasMore(vo, ecls) {
    if (ecls.kind === "vector") return "1";
    if (ecls.kind === "map" || FLAT_CONTAINER_KINDS.has(ecls.kind)) {
      const raw = this._raw(vo);
      return Array.isArray(raw) && raw.length > 0 ? "1" : "0";
    }
    return "0";
  }

  /** @param {string} name */
  _find(name) { return this.byName.get(name) || null; }

  /**
   * @param {string} name @param {"all" | "simple" | "none"} values @param {number | null} from @param {number | null} to
   * @param {number | null} token
   */
  listChildren(name, values, from, to, token) {
    const vo = this._find(name);
    if (!vo) return errorItem("Variable object not found", token);
    const cls = vo.ti.cls;
    const ecls = childKind(cls);
    if (vo.kind === "basechild") return errorItem(unsupportedMsg("expanding the class members of std::vector"), token);
    if (vo.kind === "ptr") {
      const kids = this._ptrChildren(vo).map((c) => {
        const d = this._describe(c, false);
        /** @type {any} */
        const out = { name: d.name, exp: c.exp, numchild: d.numchild };
        if (values === "all" || (values === "simple" && isSimple(c.ti.cls))) out.value = d.value;
        out.type = d.type;
        out["thread-id"] = "1";
        return out;
      });
      return resultItem({ numchild: "1", children: kids, has_more: "0" }, token);
    }
    // A class instance's children are access pseudo-nodes (public/private/protected), not real
    // fields — GDB inserts this extra layer for every C++ class/struct varobj. Expanding one of
    // those pseudo-nodes (vo.kind === "access") is what finally gives the real fields.
    if (vo.kind === "access") {
      const kids = this._ensureClassFields(vo).slice(from ?? 0, to ?? undefined);
      const children = kids.map((c) => {
        const cc = c.ti.cls;
        const d = this._describe(c, false);
        /** @type {any} */
        const out = { name: d.name, exp: c.exp, numchild: d.numchild };
        if (values === "all" || (values === "simple" && isSimple(cc))) out.value = d.value;
        out.type = d.type;
        out["thread-id"] = "1";
        if (d.displayhint) { out.displayhint = d.displayhint; out.dynamic = d.dynamic; }
        return out;
      });
      return resultItem({ numchild: String(/** @type {any} */ (vo.ti.cls).fields.length), children, has_more: "0" }, token);
    }
    if (ecls.kind === "class") {
      const kids = this._ensureAccessChildren(vo);
      const children = kids.map((c) => {
        const d = this._describe(c, false);
        // No `type` key on an access pseudo-node (ground truth: GDB never sends one for it).
        return { name: d.name, exp: c.exp, numchild: d.numchild, value: d.value, "thread-id": "1" };
      });
      return resultItem({ numchild: String(kids.length), children, has_more: "0" }, token);
    }
    if (ecls.kind === "map") {
      const raw = this._raw(vo);
      const pairs = Array.isArray(raw) ? raw : [];
      this._ensureMapChildren(vo, pairs);
      const kids = /** @type {VarObj[]} */ (vo.children).slice(from ?? 0, to ?? pairs.length * 2);
      const children = kids.map((c) => {
        const cc = c.ti.cls;
        const d = this._describe(c, false);
        /** @type {any} */
        const out = { name: d.name, exp: c.exp, numchild: d.numchild };
        if (values === "all" || (values === "simple" && isSimple(cc))) out.value = d.value;
        out.type = d.type;
        out["thread-id"] = "1";
        return out;
      });
      return resultItem({ numchild: String(pairs.length * 2), displayhint: "map", children, has_more: "0" }, token);
    }
    if (ecls.kind !== "vector" && ecls.kind !== "array" && !FLAT_CONTAINER_KINDS.has(ecls.kind)) return resultItem({ numchild: "0", has_more: "0" }, token);
    const isArr = ecls.kind === "array";
    const raw = this._raw(vo);
    const n = isArr ? ecls.n : Array.isArray(raw) ? raw.length : 0;
    this._ensureChildren(vo, n);
    const kids = /** @type {VarObj[]} */ (vo.children).slice(from ?? 0, to ?? n);
    const children = kids.map((c) => {
      const cc = c.ti.cls;
      const d = this._describe(c, false);
      /** @type {any} */
      const out = { name: d.name, exp: c.exp, numchild: d.numchild };
      if (values === "all" || (values === "simple" && isSimple(cc))) out.value = d.value;
      out.type = d.type;
      out["thread-id"] = "1";
      if (d.displayhint) { out.displayhint = d.displayhint; out.dynamic = d.dynamic; }
      return out;
    });
    // a C array is not a dynamic varobj, and GDB's list/set printers have no displayhint at all: no key on either.
    const noHint = isArr || ecls.kind === "list" || ecls.kind === "set";
    return resultItem(noHint ? { numchild: String(n), children, has_more: "0" } : { numchild: String(n), displayhint: "array", children, has_more: "0" }, token);
  }

  /** @param {VarObj} vo @param {number} n */
  _ensureChildren(vo, n) {
    const cls = vo.ti.cls;
    const ecls = cls.kind === "ref" ? cls.to : cls;
    const elemNode = ecls.elem;
    const ecl = classify(elemNode);
    if (!vo.children) vo.children = [];
    while (vo.children.length > n) { const dead = /** @type {VarObj} */ (vo.children.pop()); this._forget(dead); }
    for (let i = vo.children.length; i < n; i++) {
      /** @type {VarObj} */
      const c = {
        // GDB child names: pretty-printed vector `var1.[i]` / exp `[i]`; C array `var1.i` / exp `i`
        name: ecls.kind === "array" ? `${vo.name}.${i}` : `${vo.name}.[${i}]`, exp: ecls.kind === "array" ? `${i}` : `[${i}]`, parent: vo, index: i,
        ti: { cls: ecl, node: elemNode, gdbType: gdbType(elemNode, ecls.kind !== "array") } /* array elements keep the declared spelling (typedef std::string); vector children are template arguments (full spelling) */, children: null, root: vo.root, varName: vo.varName,
        frameId: vo.frameId, fn: vo.fn, blockId: vo.blockId, global: vo.global, lastValue: null, lastInScope: true, addrName: vo.addrName,
      };
      c.lastValue = this._value(c);
      vo.children.push(c);
      this.byName.set(c.name, c);
    }
  }

  /**
   * A map's children are FLAT and ALTERNATING (key, value, key, value, ...; numchild = 2×N for N
   * entries), not N pair-struct children — ground truth from a real
   * `gdb -i mi -enable-pretty-printing` session (displayhint:"map", `.[0]`=key type "const K",
   * `.[1]`=value type "V", `.[2]`=next key, ...). `pairs` is the raw [[k,v],...] trace value.
   * @param {VarObj} vo @param {any[]} pairs
   */
  _ensureMapChildren(vo, pairs) {
    const cls = vo.ti.cls;
    const ecls = cls.kind === "ref" ? cls.to : cls;
    const keyCl = classify(/** @type {any} */ (ecls).keyNode), valCl = classify(/** @type {any} */ (ecls).valNode);
    const n = pairs.length * 2;
    if (!vo.children) vo.children = [];
    while (vo.children.length > n) { const dead = /** @type {VarObj} */ (vo.children.pop()); this._forget(dead); }
    for (let i = vo.children.length; i < n; i++) {
      const isKey = (i & 1) === 0;
      const elemNode = isKey ? /** @type {any} */ (ecls).keyNode : /** @type {any} */ (ecls).valNode;
      const ecl = isKey ? keyCl : valCl;
      /** @type {VarObj} */
      const c = {
        name: `${vo.name}.[${i}]`, exp: `[${i}]`, parent: vo, index: i,
        ti: { cls: ecl, node: elemNode, gdbType: (isKey ? "const " : "") + gdbType(elemNode, true) },
        children: null, root: vo.root, varName: vo.varName,
        frameId: vo.frameId, fn: vo.fn, blockId: vo.blockId, global: vo.global, lastValue: null, lastInScope: true, addrName: vo.addrName,
      };
      c.lastValue = this._value(c);
      vo.children.push(c);
      this.byName.set(c.name, c);
    }
  }

  /**
   * A class instance's access pseudo-nodes (public/private/protected), one per level that has a
   * field, ALWAYS in that fixed public/private/protected order regardless of declaration order —
   * confirmed against real GDB with declaration orders public+protected+private and
   * protected+private+public, both giving public/private/protected. GDB's own C++ varobj support
   * inserts this extra layer for every class/struct (never a Python pretty-printer:
   * `-var-list-children` on it has no `dynamic`/`displayhint`, and its own children have no `type`
   * key). Memoized like `_ptrChildren`: the set of access levels is fixed by the class's static
   * layout.
   * @param {VarObj} vo
   */
  _ensureAccessChildren(vo) {
    if (vo.children) return vo.children;
    const cls = childKind(vo.ti.cls);
    const present = new Set(/** @type {any} */ (cls).fields.map((/** @type {any} */ f) => f.access));
    const order = ["public", "private", "protected"].filter((a) => present.has(a));
    vo.children = order.map((access, i) => /** @type {VarObj} */ ({
      name: `${vo.name}.${access}`, exp: access, parent: vo, index: i, kind: "access",
      ti: { cls: { fields: /** @type {any} */ (cls).fields.filter((/** @type {any} */ f) => f.access === access) }, node: null, gdbType: "" },
      children: null, root: vo.root, varName: vo.varName, frameId: vo.frameId, fn: vo.fn, blockId: vo.blockId, global: vo.global,
      lastValue: "", lastInScope: true, addrName: vo.addrName,
    }));
    for (const c of vo.children) this.byName.set(c.name, c);
    return vo.children;
  }

  /** Real fields under one access pseudo-node (`v1.public.x`, `exp:"x"`, plain field name/type). @param {VarObj} vo */
  _ensureClassFields(vo) {
    if (vo.children) return vo.children;
    const fields = /** @type {any} */ (vo.ti.cls).fields;
    vo.children = fields.map((/** @type {any} */ f, /** @type {number} */ i) => {
      /** @type {VarObj} */
      const c = {
        name: `${vo.name}.${f.name}`, exp: f.name, parent: vo, index: i, kind: "classfield", fieldName: f.name,
        ti: { cls: f.cls, node: f.cls.node, gdbType: f.gdbType }, children: null, root: vo.root, varName: vo.varName,
        frameId: vo.frameId, fn: vo.fn, blockId: vo.blockId, global: vo.global, lastValue: null, lastInScope: true, addrName: vo.addrName,
      };
      c.lastValue = this._value(c);
      return c;
    });
    for (const c of vo.children) this.byName.set(c.name, c);
    return vo.children;
  }

  /** @param {VarObj} vo */
  _forget(vo) {
    this.byName.delete(vo.name);
    if (vo.children) for (const c of vo.children) this._forget(c);
  }

  /** @param {VarObj} vo @returns {number} */
  _count(vo) { return 1 + (vo.children ? vo.children.reduce((a, c) => a + this._count(c), 0) : 0); }

  /** @param {string} name @param {boolean} childrenOnly @param {number | null} token */
  delete(name, childrenOnly, token) {
    const vo = this._find(name);
    if (!vo) return errorItem("Variable object not found", token);
    if (childrenOnly) {
      const n = vo.children ? vo.children.reduce((a, c) => a + this._count(c), 0) : 0;
      if (vo.children) for (const c of vo.children) this._forget(c);
      vo.children = null;
      return resultItem({ ndeleted: String(n) }, token);
    }
    const n = this._count(vo);
    this._forget(vo);
    if (vo.parent && vo.parent.children) vo.parent.children = vo.parent.children.filter((c) => c !== vo);
    else this.roots = this.roots.filter((r) => r !== vo);
    return resultItem({ ndeleted: String(n) }, token);
  }

  /** @param {string} name @param {number | null} token */
  evaluateVar(name, token) {
    const vo = this._find(name);
    if (!vo) return errorItem("Variable object not found", token);
    return resultItem({ value: this._value(vo) }, token);
  }

  /** @param {string} name @param {number | null} token */
  info(name, token) {
    const vo = this._find(name);
    if (!vo) return errorItem("Variable object not found", token);
    return resultItem({ type: vo.ti.gdbType }, token);
  }

  /**
   * `-var-update`: changelist, roots newest first, depth-first inside a root.
   * @param {string} target `*` or a varobj name @param {boolean} withValues @param {number | null} token
   */
  update(target, withValues, token) {
    /** @type {VarObj[]} */
    let roots;
    if (target === "*" || target === "") roots = [...this.roots].reverse();
    else {
      const vo = this._find(target);
      if (!vo) return errorItem("Variable object not found", token);
      roots = [vo.root === vo ? vo : vo];
    }
    /** @type {any[]} */
    const list = [];
    const visit = (/** @type {VarObj} */ vo) => {
      const inScope = this._inScope(vo);
      if (!inScope) {
        if (vo.lastInScope) list.push({ name: vo.name, in_scope: "false", type_changed: "false", has_more: "0" });
        vo.lastInScope = false;
        return;
      }
      const cls = vo.ti.cls;
      const ecls = cls.kind === "ref" ? cls.to : cls;
      let grew = false;
      if (vo.children && ecls.kind === "map") {
        const raw = this._raw(vo);
        const pairs = Array.isArray(raw) ? raw : [];
        if (pairs.length * 2 !== vo.children.length) { this._ensureMapChildren(vo, pairs); grew = true; }
      } else if (vo.children && (ecls.kind === "vector" || FLAT_CONTAINER_KINDS.has(ecls.kind))) {
        const raw = this._raw(vo);
        const n = Array.isArray(raw) ? raw.length : 0;
        if (n !== vo.children.length) { this._ensureChildren(vo, n); grew = true; }
      }
      const cur = this._value(vo);
      if (!vo.lastInScope || cur !== vo.lastValue || grew) {
        /** @type {any} */
        const it = { name: vo.name };
        if (withValues) it.value = cur;
        it.in_scope = "true";
        it.type_changed = "false";
        if (isDynamic(ecls)) {
          if (ecls.kind === "map") it.displayhint = "map";
          else if (ecls.kind !== "list" && ecls.kind !== "set") it.displayhint = ecls.kind === "string" ? "string" : "array";
          it.dynamic = "1";
        }
        it.has_more = this._hasMore(vo, ecls);
        if (grew && vo.children) it.new_num_children = String(vo.children.length);
        list.push(it);
      }
      vo.lastValue = cur;
      vo.lastInScope = true;
      if (vo.children) for (const c of vo.children) visit(c);
    };
    for (const r of roots) visit(r);
    return resultItem({ changelist: list }, token);
  }

  /**
   * `-data-evaluate-expression`: plain names, `&name`, arithmetic/subscript expressions (value only, `print` format).
   * @param {string} expr @param {number | null} token
   */
  evaluate(expr, token) {
    const e = expr.trim();
    if (/^[A-Za-z_]\w*\s*\.\s*[A-Za-z_]\w*\s*\(.*\)$/.test(e)) return errorItem("Cannot evaluate function -- may be inlined", token);
    const am = /^&\s*\(?\s*([A-Za-z_]\w*)\s*\)?$/.exec(e);
    if (am) {
      const t = this._resolve(am[1]);
      if ("error" in t) return errorItem(t.error, token);
      return resultItem({ value: `(${gdbType(pointerTo(t.node))}) 0x${this._model.varAddr(t.frameId ?? 0, am[1]).toString(16)}` }, token);
    }
    if (!/^[A-Za-z_]\w*$/.test(e) || e === "true" || e === "false") {
      let val;
      try {
        const fr = this._frames()[Math.min(this.host.exec.selectedLevel, Math.max(this._frames().length - 1, 0))];
        val = evalAst(parseExpr(e), this._lookup(fr ? fr.frameId : null));
      } catch (x) { return errorItem(/** @type {any} */ (x).message, token); }
      const rc = resultClass(val);
      if (!rc) return errorItem(unsupportedMsg(`expression '${e}' (its value is a container)`), token);
      return resultItem({ value: printValue(rc.cls, rawOf(val)) }, token);
    }
    const r = this._resolve(e);
    if ("error" in r) return errorItem(r.error, token);
    const thisPtr = isThisPtr(e, r.cls);
    if (!isSupported(r.cls) && !thisPtr) return errorItem(unsupportedMsg(`type '${r.gdbType}'`), token);
    // `this` evaluates to its own pseudo-address, same as var-create's value for it — ground truth:
    // real GDB shows `this` as a bare address here too. Any OTHER Class* stays rejected above
    // (isSupported is false and thisPtr is false for it) — see isThisPtr's comment.
    if (thisPtr) return resultItem({ value: "0x" + this._model.varAddr(r.frameId ?? 0, e).toString(16) }, token);
    const fake = { name: "", exp: e, parent: null, index: -1, ti: { cls: r.cls, node: r.node, gdbType: r.gdbType }, children: null, varName: e, frameId: r.frameId, fn: r.fn, blockId: r.blockId, global: r.global, lastValue: null, lastInScope: true, addrName: e };
    /** @type {any} */ (fake).root = fake;
    // `print`-style value (children included: `{1, 2, 3}`, `std::vector of length 3, capacity 4 = {0, 1, 4}`)
    const cap = r.cls.kind === "vector" || (r.cls.kind === "ref" && r.cls.to.kind === "vector") ? this._capacityOf(/** @type {any} */ (fake)) : undefined;
    // A class reference evaluates to a BARE address, no `: {...}` suffix (ground truth: unlike a
    // scalar reference's `@addr: value`, evaluating a `const Acc&` parameter here gives only
    // `@0xADDR` — the field values are reachable through -var-create/-var-list-children instead).
    if (r.cls.kind === "ref" && r.cls.to.kind === "class") {
      return resultItem({ value: `@0x${this._model.varAddr(r.frameId ?? 0, e).toString(16)}` }, token);
    }
    const pv = printValue(r.cls, this._raw(/** @type {any} */ (fake)), cap);
    return resultItem({ value: r.cls.kind === "ref" ? `@0x${this._model.varAddr(r.frameId ?? 0, e).toString(16)}: ${pv}` : pv }, token);
  }
}
