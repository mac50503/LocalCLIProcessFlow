import type { AnyNodeType } from "./types.js";

export class NodeRegistry {
  private readonly nodes = new Map<string, AnyNodeType>();

  register(node: AnyNodeType): this {
    if (this.nodes.has(node.type)) throw new Error(`Node type "${node.type}" is already registered`);
    this.nodes.set(node.type, node);
    return this;
  }

  get(type: string): AnyNodeType | undefined {
    return this.nodes.get(type);
  }

  list(): AnyNodeType[] {
    return [...this.nodes.values()];
  }
}
