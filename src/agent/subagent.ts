/**
 * Subagent system — agent type definitions, tool filtering, and execution.
 *
 * Each agent type maps to a routing pool (subagent/<type>) so users can
 * independently score models per agent type via the API pool manager.
 */

import { cwd } from "node:process";
import os from "node:os";

import { AgentContext, AgentLoop } from "./loop.ts";
import { PermissionPipeline } from "../permissions/pipeline.ts";
import { PermissionRules } from "../permissions/rules.ts";
import type { QueryEngine } from "../query/engine.ts";
import type { ModelSelector } from "../routing/protocol.ts";
import type { ModelRegistry } from "../models/registry.ts";
import { makeToolContext, type ToolContext } from "../tools/types.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { StreamEvent } from "../messages/types.ts";
import { TASK_HIERARCHY } from "../routing/tasks.ts";

// -- Agent type definitions --

export interface AgentTypeSpec {
  name: string;
  description: string;
  /** Explicit allowlist. null = all tools (minus disallowed). */
  tools: string[] | null;
  disallowed_tools: string[];
  read_only: boolean;
  /** Routing pool key, e.g. "subagent/explore". */
  task_type: string;
}

export const BUILTIN_AGENT_TYPES: Record<string, AgentTypeSpec> = {
  general: {
    name: "general",
    description:
      "General-purpose agent for complex multi-step tasks. Full tool access.",
    tools: null,
    disallowed_tools: ["agent"],
    read_only: false,
    task_type: "subagent/general",
  },
  explore: {
    name: "explore",
    description:
      "Read-only filesearch agent. Fast model, no file edits.",
    tools: ["read", "glob", "grep", "skill_view"],
    disallowed_tools: ["bash", "write", "edit", "agent"],
    read_only: true,
    task_type: "subagent/explore",
  },
  plan: {
    name: "plan",
    description:
      "Software architect agent. Plans implementations, no file edits.",
    tools: null,
    disallowed_tools: ["write", "edit", "agent"],
    read_only: true,
    task_type: "subagent/plan",
  },
};

// -- Tool filtering --

/** Build a filtered ToolRegistry for a subagent type. Never mutates the parent. */
function filterToolsForAgent(
  parentRegistry: ToolRegistry,
  spec: AgentTypeSpec,
): ToolRegistry {
  const filtered = new (parentRegistry.constructor as any)() as ToolRegistry;

  if (spec.tools !== null) {
    // Explicit allowlist.
    for (const name of spec.tools) {
      const tool = parentRegistry.get(name);
      if (tool) filtered.register(tool);
    }
  } else {
    // null = all tools.
    for (const tool of parentRegistry.listAll()) {
      filtered.register(tool);
    }
  }

  // Apply disallowed tools.
  filtered.filterDenied(spec.disallowed_tools);

  // read_only safety belt — remove any destructive tool.
  if (spec.read_only) {
    for (const tool of filtered.listAll()) {
      if (!tool.isReadOnly()) filtered.filterDenied([tool.name]);
    }
  }

  // Always prevent recursion.
  filtered.filterDenied(["agent"]);

  return filtered;
}

// -- Subagent execution --

function buildSubagentSystemPrompt(
  spec: AgentTypeSpec,
  workingDir: string,
): string {
  const envInfo = [
    `Working directory: ${workingDir}`,
    `Operating system: ${os.type()}`,
    `Current date: ${new Date().toISOString().slice(0, 10)}`,
  ].join("\n");
  return (
    `${envInfo}\n\n` +
    `You are a ${spec.name} subagent. ${spec.description}\n` +
    `Execute the delegated task faithfully and return a complete result. ` +
    `Work autonomously — do not ask the user questions.`
  );
}

function buildSubagentPermissionPipeline(
  filteredTools: ToolRegistry,
): PermissionPipeline {
  const rules = new PermissionRules();
  for (const tool of filteredTools.listAll()) {
    rules.addAllow(tool.name);
  }
  return new PermissionPipeline(rules);
}

export function getAgentTypes(
  customAgents?: Record<string, AgentTypeSpec> | null,
): Record<string, AgentTypeSpec> {
  return { ...BUILTIN_AGENT_TYPES, ...(customAgents ?? {}) };
}

export async function runSubagent(
  prompt: string,
  agentType: string,
  opts: {
    queryEngine: QueryEngine;
    modelRegistry: ModelRegistry;
    toolRegistry: ToolRegistry;
    modelSelector: ModelSelector;
    workingDir: string;
    eventCallback?: ((event: StreamEvent) => void) | null;
    customAgents?: Record<string, AgentTypeSpec> | null;
  },
): Promise<string> {
  const {
    queryEngine,
    modelRegistry,
    toolRegistry,
    modelSelector,
    workingDir,
    eventCallback = null,
    customAgents = null,
  } = opts;

  // Case-insensitive lookup.
  const agentTypeLower = agentType.toLowerCase().trim();
  const available = getAgentTypes(customAgents);
  const spec = available[agentTypeLower];
  if (!spec) {
    const names = Object.keys(available).sort().join(", ");
    return `Error: unknown agent type '${agentType}'. Available: ${names}`;
  }

  // Build filtered tool set.
  const filteredTools = filterToolsForAgent(toolRegistry, spec);

  // Build permission pipeline (auto-allow all filtered tools).
  const subagentPipeline = buildSubagentPermissionPipeline(filteredTools);

  // Build system prompt.
  const systemPrompt = buildSubagentSystemPrompt(spec, workingDir);

  // Build context — task_type drives routing via the pool hierarchy.
  const ctx = new AgentContext({
    task_type: spec.task_type,
    model_override: null,
    tool_context: makeToolContext({ working_dir: workingDir }),
    system_prompt: systemPrompt,
  });

  // Create fresh AgentLoop (isolated messages, handoff auto-skipped for
  // non-main).
  const subagentLoop = new AgentLoop(
    queryEngine,
    filteredTools,
    subagentPipeline,
    modelSelector,
    modelRegistry,
  );

  // Run to completion.
  let finalText = "";
  try {
    for await (const event of subagentLoop.run(prompt, ctx)) {
      if (eventCallback) await eventCallback(event);
      if (event.type === "text_delta") {
        finalText += (event as any).text ?? "";
      }
    }
  } catch (e) {
    return `Subagent error: ${(e as Error).message}`;
  }
  return finalText.trim();
}
