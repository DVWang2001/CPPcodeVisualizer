import ContainerParser from "./ContainerParser";

class DefaultParser extends ContainerParser {
  canHandle(_containerName, _varObj) {
    return true; // catch-all
  }

  parse(varObj, _context) {
    return { done: true, values: (varObj.children || []).map(c => c.value) };
  }
}

export default DefaultParser;
