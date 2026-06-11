import ContainerParser from "./ContainerParser";

class StringParser extends ContainerParser {
  canHandle(containerName, _varObj) {
    return containerName === "string";
  }

  parse(varObj, _context) {
    let s = varObj.value || "";
    if (s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1);
    return { done: true, values: s.split("") };
  }
}

export default StringParser;
