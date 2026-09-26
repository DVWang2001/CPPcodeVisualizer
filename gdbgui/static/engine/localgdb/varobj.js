// GDB variable objects (S4 minimal set) over the recorded trace.
//
// Supported: a plain variable name whose type is int-family / bool / char / float / double /
// std::string, or std::vector<T> (T supported, nested vectors included), or a reference to those.
// Anything else (map/set/deque/stack/queue/priority_queue, pointers, structs, arrays, arithmetic,
// `&x`, `x[i]`, member calls) gets an explicit MI error; `name.method()` gets the error real GDB gives
// for the libstdc++ methods the UI probes (`Cannot evaluate function -- may be inlined`).
//
// Mirrors what the golden sample shows (spec §5): auto names var1, var2, ... (the counter also advances
// when the create fails), vectors are dynamic varobjs with displayhint "array" and children
// `name.[i]`, `numchild` is "0" until the children were listed, `-var-update` walks the roots newest
// first and reports value changes, `in_scope:"false"` when the varobj's block is left and the value
// again when it is re-entered.
// Plain ES module, no DOM / Node APIs.

import { classify, gdbType, isSupported, isDynamic, isSimple } from "./types.js";
import { valueOf } from "./model.js";
import { resultItem, errorItem, unsupportedMsg } from "./mi.js";
import { parseExpr, evalAst, collectNames, resultClass, rawOf } from "./expr.js";

/** @param {any} node */
const pointerTo = (node) => ({ k: "p", to: node });

const own = (/** @type {object} */ o, /** @type {string} */ k) => Object.prototype.hasOwnProperty.call(o, k);

/**
 * @typedef {{ name: string, exp: string, parent: VarObj | null, index: number, ti: any, children: VarObj[] | null,
 *   root: VarObj, varName: string, frameId: number | null, fn: string, blockId: number, global: boolean,
 *   lastValue: string | null, lastInScope: boolean, addrName: string, kind?: "var" | "expr" | "ptr" | "ptrchild" | "basechild" | "elem",
 *   ast?: any, pointee?: any }} VarObj
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
    if (!/^[A-Za-z_]\w*$/.test(e)) return this._createExpr(name, e, token);
    const r = this._resolve(e);
    if ("error" in r) return errorItem(r.error, token);
    const cls = r.cls;
    if (!isSupported(cls)) return errorItem(unsupportedMsg(`type '${r.gdbType}'`), token);
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
    if (!(scalar || (pc.kind === "vector" && isSupported(pc)))) return errorItem(unsupportedMsg(`type '${gdbType(pointerTo(r.node))}'`), token);
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
    return vo.ti.cls.kind === "vector" ? [] : vo.ti.cls.kind === "string" ? "" : 0;
  }

  /** @param {VarObj} vo */
  _raw(vo) {
    if (vo.kind === "expr") {
      try { return rawOf(evalAst(vo.ast, this._lookup(vo.frameId))); } catch (x) { return undefined; }
    }
    if (vo.kind === "ptrchild") return this._rawRoot(/** @type {VarObj} */ (vo.parent));
    if (!vo.parent) return this._rawRoot(vo);
    const pr = this._raw(vo.parent);
    return Array.isArray(pr) ? pr[vo.index] : undefined;
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
    if (vo.kind === "expr") {
      try { return valueOf(vo.ti.cls, rawOf(evalAst(vo.ast, this._lookup(vo.frameId)))); } catch (x) { return `<error: ${/** @type {any} */ (x).message}>`; }
    }
    const cls = vo.ti.cls;
    const ecls = cls.kind === "ref" ? cls.to : cls;
    const raw = this._raw(vo);
    const s = valueOf(ecls, raw, ecls.kind === "vector" ? this._capacityOf(vo) : undefined);
    if (cls.kind === "ref") return `@0x${this._model.varAddr(vo.frameId ?? 0, vo.varName).toString(16)}: ${s}`;
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
    const cls = vo.ti.cls;
    const ecls = cls.kind === "ref" ? cls.to : cls;
    const nc = vo.kind === "ptr" || vo.kind === "basechild" ? "1" : String(vo.children ? vo.children.length : 0);
    const p = { name: vo.name, numchild: nc, value: this._value(vo), type: vo.ti.gdbType };
    if (!vo.root.global) /** @type {any} */ (p)["thread-id"] = "1";
    if (isDynamic(ecls)) {
      /** @type {any} */ (p).displayhint = ecls.kind === "string" ? "string" : "array";
      /** @type {any} */ (p).dynamic = "1";
    }
    if (isCreate) /** @type {any} */ (p).has_more = ecls.kind === "vector" ? "1" : "0";
    return p;
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
    const ecls = cls.kind === "ref" ? cls.to : cls;
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
    if (ecls.kind !== "vector") return resultItem({ numchild: "0", has_more: "0" }, token);
    const raw = this._raw(vo);
    const n = Array.isArray(raw) ? raw.length : 0;
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
    return resultItem({ numchild: String(n), displayhint: "array", children, has_more: "0" }, token);
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
        name: `${vo.name}.[${i}]`, exp: `[${i}]`, parent: vo, index: i,
        ti: { cls: ecl, node: elemNode, gdbType: gdbType(elemNode, true) }, children: null, root: vo.root, varName: vo.varName,
        frameId: vo.frameId, fn: vo.fn, blockId: vo.blockId, global: vo.global, lastValue: null, lastInScope: true, addrName: vo.addrName,
      };
      c.lastValue = this._value(c);
      vo.children.push(c);
      this.byName.set(c.name, c);
    }
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
      if (vo.children && ecls.kind === "vector") {
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
        if (isDynamic(ecls)) { it.displayhint = ecls.kind === "string" ? "string" : "array"; it.dynamic = "1"; }
        it.has_more = "0";
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
   * `-data-evaluate-expression`: plain variable names only.
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
    if (!/^[A-Za-z_]\w*$/.test(e)) {
      let val;
      try {
        const fr = this._frames()[Math.min(this.host.exec.selectedLevel, Math.max(this._frames().length - 1, 0))];
        val = evalAst(parseExpr(e), this._lookup(fr ? fr.frameId : null));
      } catch (x) { return errorItem(/** @type {any} */ (x).message, token); }
      const rc = resultClass(val);
      if (!rc) return errorItem(unsupportedMsg(`expression '${e}' (its value is a container)`), token);
      return resultItem({ value: valueOf(rc.cls, rawOf(val)) }, token);
    }
    const r = this._resolve(e);
    if ("error" in r) return errorItem(r.error, token);
    if (!isSupported(r.cls)) return errorItem(unsupportedMsg(`type '${r.gdbType}'`), token);
    const fake = { name: "", exp: e, parent: null, index: -1, ti: { cls: r.cls, node: r.node, gdbType: r.gdbType }, children: null, varName: e, frameId: r.frameId, fn: r.fn, blockId: r.blockId, global: r.global, lastValue: null, lastInScope: true, addrName: e };
    /** @type {any} */ (fake).root = fake;
    return resultItem({ value: this._value(/** @type {any} */ (fake)) }, token);
  }
}
