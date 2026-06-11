import ContainerParser from "./ContainerParser";

const isAccessSection = (c) =>
  (c.exp === "public" || c.exp === "private" || c.exp === "protected") && !c.value;

class ArrayParser extends ContainerParser {
  canHandle(containerName, _varObj) {
    return containerName === "array";
  }

  parse(varObj, context) {
    const { trimmedInst, expressions, GdbVariable } = context;

    // Strategy 1: pretty-printer present — children ARE the elements
    if (!varObj.children.every(isAccessSection)) {
      return { done: true, values: varObj.children.map(c => c.value) };
    }

    // Strategy 2: struct layout — navigate public → _M_elems → elements
    const needsFetch = varObj.children.filter(
      c => c.numchild > 0 && (!c.children || c.children.length === 0)
    );
    if (needsFetch.length > 0) {
      needsFetch.forEach(c => {
        if (!c.show_children_in_ui) {
          GdbVariable.fetch_and_show_children_for_var(c.name);
        }
      });
      return { done: false, retryMs: 150 };
    }

    const inner = varObj.children.flatMap(c => c.children || []);
    const cArr = inner.find(c =>
      /\[\d+\]/.test(c.type || "") ||
      c.exp === "_M_elems" ||
      (c.type || "").includes("__array_traits")
    );

    if (!cArr) {
      // No C-array child: inner contains direct elements
      return { done: true, values: inner.map(c => c.value) };
    }

    if (cArr.children && cArr.children.length > 0) {
      // _M_elems children already loaded
      return { done: true, values: cArr.children.map(c => c.value) };
    }

    if (cArr.numchild > 0) {
      // Strategy 3: fetch _M_elems children (guard prevents double-fetch)
      if (!cArr.show_children_in_ui) {
        GdbVariable.fetch_and_show_children_for_var(cArr.name);
      }
      return { done: false, retryMs: 150 };
    }

    // Strategy 4: numchild=0, cArr.value may be "{1,2,3}" or "[N]" (size indicator)
    const rawCArr = (cArr.value || "").replace(/^\{/, "").replace(/\}$/, "").trim();
    if (rawCArr && !/^\[\d+\]$/.test(rawCArr)) {
      return { done: true, values: rawCArr.split(",").map(s => s.trim()) };
    }

    // Strategy 5: varObj.value fallback — "{_M_elems = {1, 2, 3}}"
    const vval = varObj.value || "";
    const innerMatch = vval.match(/\{([^{}]+)\}/);
    if (innerMatch && innerMatch[1].trim()) {
      return { done: true, values: innerMatch[1].split(",").map(s => s.trim()) };
    }

    // Strategy 6: last resort — create individual element vars a[0], a[1], ...
    const arrSizeMatch = (cArr.type || "").match(/\[(\d+)\]/);
    const N = arrSizeMatch ? parseInt(arrSizeMatch[1]) : 0;
    if (N > 0) {
      const elemVals = [];
      let allReady = true;
      for (let i = 0; i < N; i++) {
        const elemExpr = `${trimmedInst}[${i}]`;
        const elemObj = (expressions || []).find(e => e.expression === elemExpr);
        if (elemObj && elemObj.value !== undefined && elemObj.value !== "") {
          elemVals.push(elemObj.value);
        } else {
          if (!elemObj) GdbVariable.create_variable(elemExpr, "watch");
          allReady = false;
        }
      }
      if (allReady && elemVals.length === N) return { done: true, values: elemVals };
      return { done: false, retryMs: 150 };
    }

    return { done: true, values: [] };
  }
}

export default ArrayParser;
