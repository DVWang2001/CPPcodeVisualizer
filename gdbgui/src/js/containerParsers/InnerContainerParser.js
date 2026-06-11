import ContainerParser from "./ContainerParser";

const isInner = (child) =>
  (typeof child.value === "string" && child.value.includes("of length")) ||
  (typeof child.type === "string" && (
    child.type.includes("std::deque") ||
    child.type.includes("std::vector") ||
    child.type.includes("std::list")
  ));

const isEmpty = (child) =>
  isInner(child) && (
    /of length 0\b/.test(child.value || "") ||
    parseInt(child.numchild) === 0
  );

class InnerContainerParser extends ContainerParser {
  canHandle(containerName, varObj) {
    return (varObj.children || []).some(isInner);
  }

  parse(varObj, context) {
    const { containerName, GdbVariable } = context;
    const children = varObj.children || [];

    const missing = children.filter(
      c => isInner(c) && !isEmpty(c) && !(c.children && c.children.length > 0)
    );

    if (missing.length > 0) {
      // Fix numchild before fetching (dynamic varobj may have NaN numchild).
      // child is a reference into the store array — in-place mutation suffices;
      // no store.set needed here (GDB response will trigger the real store.set).
      missing.slice(0, 5).forEach(child => {
        if (!child.numchild || isNaN(child.numchild)) {
          const m = (child.value || "").match(/of length (\d+)/);
          child.numchild = m ? parseInt(m[1]) : 1;
        }
      });
      missing.slice(0, 5).forEach(child =>
        GdbVariable.fetch_and_show_children_for_var(child.name)
      );
      return { done: false, retryMs: 200 };
    }

    let values = children.map(child => {
      if (isEmpty(child)) return [];
      if (isInner(child) && child.children && child.children.length > 0) {
        return child.children.map(c => c.value);
      }
      return child.value;
    });

    // Flatten single-wrapper containers (stack/queue/deque without pretty-printer)
    if (
      ["queue", "stack", "deque"].includes(containerName) &&
      values.length === 1 &&
      Array.isArray(values[0])
    ) {
      values = values[0];
    }

    return { done: true, values };
  }
}

export default InnerContainerParser;
