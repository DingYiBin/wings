/**
 * Tool registry — central catalogue of all available tools.
 *
 * Tools are registered by name and can be filtered by enabled state and
 * deny lists. The registry also generates the tool schemas sent to the LLM.
 */

import type { Tool } from "./types.ts";

export class ToolRegistry {
  private _tools: Map<string, Tool> = new Map();

  /** Register a tool. Overwrites if the name already exists. */
  register(tool: Tool): void {
    this._tools.set(tool.name, tool);
  }

  /** Look up a tool by name. */
  get(name: string): Tool | undefined {
    return this._tools.get(name);
  }

  /** Return all registered tools. */
  listAll(): Tool[] {
    return [...this._tools.values()];
  }

  /** Return only enabled tools. */
  listEnabled(): Tool[] {
    return this.listAll().filter((t) => t.isEnabled());
  }

  /** Generate tool schemas to send to the LLM.
   *
   * Only enabled tools are included. Each schema includes name, description,
   * and JSON Schema input_schema.
   */
  getSchemas(): Array<Record<string, unknown>> {
    const schemas: Array<Record<string, unknown>> = [];
    for (const tool of this.listEnabled()) {
      schemas.push({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema(),
      });
    }
    return schemas;
  }

  /** Remove tools whose names are in the deny list. */
  filterDenied(denyList: string[]): void {
    for (const name of denyList) {
      this._tools.delete(name);
    }
  }
}
