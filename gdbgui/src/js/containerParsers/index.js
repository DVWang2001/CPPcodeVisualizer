import StringParser from "./StringParser";
import InnerContainerParser from "./InnerContainerParser";
import ArrayParser from "./ArrayParser";
import MapParser from "./MapParser";
import DefaultParser from "./DefaultParser";

// Parser chain — order mirrors the original if/else in VisualizerHelper.js
const parserChain = [
  new StringParser(),
  new InnerContainerParser(), // must precede ArrayParser (inner-container check runs first)
  new ArrayParser(),
  new MapParser(),
  new DefaultParser(),        // catch-all — must stay last
];

/**
 * Walk the chain and return the first matching parser's result.
 * Returns null when no parser handles the given container (caller uses legacy logic).
 *
 * @param {string} containerName
 * @param {object} varObj
 * @param {{ trimmedInst: string, expressions: any[], GdbVariable: object }} context
 * @returns {{ done: boolean, values?: any[], retryMs?: number } | null}
 */
export function resolveChildValues(containerName, varObj, context) {
  for (const parser of parserChain) {
    if (parser.canHandle(containerName, varObj)) {
      return parser.parse(varObj, context);
    }
  }
  return null; // no parser registered yet — caller falls through to legacy logic
}
