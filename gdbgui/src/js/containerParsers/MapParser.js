import ContainerParser from "./ContainerParser";

class MapParser extends ContainerParser {
  canHandle(containerName, _varObj) {
    return containerName === "map" || containerName === "unordered_map";
  }

  parse(varObj, _context) {
    const ch = varObj.children || [];
    const firstStr = ch.length > 0 ? String(ch[0].value || "").trim() : "";

    // GDB new format (displayhint=map): flat alternating [0]=key, [1]=val, ...
    if (ch.length > 0 && !firstStr.includes("first = ") && ch.length % 2 === 0) {
      const values = [];
      for (let i = 0; i + 1 < ch.length; i += 2) {
        let kStr = String(ch[i].value || "").trim();
        let vStr = String(ch[i + 1].value || "").trim();
        if (vStr.startsWith('"') && vStr.endsWith('"')) vStr = vStr.slice(1, -1);
        values.push({ key: kStr, value: vStr });
      }
      return { done: true, values };
    }

    // GDB old format: each child value is "{first = K, second = V}"
    const values = ch.map((child, idx) => {
      const str = String(child.value || "").trim();
      const fi = str.indexOf("first = ");
      const si = str.lastIndexOf(", second = ");
      if (fi !== -1 && si !== -1 && si > fi) {
        return { key: str.slice(fi + 8, si).trim(), value: str.slice(si + 11).replace(/\s*\}$/, "").trim() };
      }
      return { key: child.expression || String(idx), value: str };
    });
    return { done: true, values };
  }
}

export default MapParser;
