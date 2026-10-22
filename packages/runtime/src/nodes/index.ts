import { NodeRegistry } from "../registry.js";
import { conditionCheck } from "./condition-check.js";
import { inputJson } from "./input-json.js";
import { outputResult } from "./output-result.js";
import { transformMap } from "./transform-map.js";
import { validateSchema } from "./validate-schema.js";

export const deterministicNodes = [inputJson, transformMap, conditionCheck, validateSchema, outputResult];

export function createDefaultRegistry(): NodeRegistry {
  const registry = new NodeRegistry();
  for (const node of deterministicNodes) registry.register(node);
  return registry;
}
