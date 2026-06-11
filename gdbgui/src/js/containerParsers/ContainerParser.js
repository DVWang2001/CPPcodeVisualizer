class ContainerParser {
  /**
   * @param {string} containerName
   * @param {object} _varObj
   * @returns {boolean}
   */
  canHandle(containerName, _varObj) { // eslint-disable-line no-unused-vars
    return false;
  }

  /**
   * @param {object} _varObj
   * @param {{ trimmedInst: string, expressions: any[], GdbVariable: object }} _context
   * @returns {{ done: boolean, values?: any[], retryMs?: number }}
   */
  parse(_varObj, _context) {
    throw new Error("Not implemented");
  }
}

export default ContainerParser;
