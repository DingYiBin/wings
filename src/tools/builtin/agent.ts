/**
 * Agent tool — launch a subagent to handle complex multi-step tasks.
 *
 * Uses a factory function (closure) for dependency injection. The tool
 * needs references to query_engine, registry, etc. but `buildTool()` only
 * receives ToolContext at call time.
 */

import { z } from "zod";

import { buildTool, type Tool, type ToolContext, type ToolResult } from "../types.ts";
import { getAgentTypes, runSubagent, type AgentTypeSpec } from "../../agent/subagent.ts";
import type { QueryEngine } from "../../query/engine.ts";
import type { ModelRegistry } from "../../models/registry.ts";
import type { ToolRegistry } from "../registry.ts";
import type { ModelSelector } from "../../routing/protocol.ts";
import type { PermissionRules } from "../../permissions/rules.ts";

function buildDescription(custom: Record<string, AgentTypeSpec>): string {
  const lines = [
    "Launch a new agent to handle complex, multi-step tasks autonomously.",
    "",
    "The Agent tool launches specialized agents (subprocesses) that " +
    "autonomously handle complex tasks. Each agent type has specific " +
    "capabilities and tools available to it.",
    "",
    "Available agent types and the tools they have access to:",
    "- general: General-purpose agent for researching complex " +
    "questions, searching for code, and executing multi-step tasks. (Tools: *)",
    "- explore: Fast agent specialized for exploring codebases. " +
    "(Tools: Read, Glob, Grep, SkillView)",
    "- plan: Software architect agent for designing implementation plans. " +
    "(Tools: all except Write, Edit, Agent)",
  ];

  for (const [name, spec] of Object.entries(custom).sort()) {
    const toolsDesc = spec.tools ? spec.tools.join(", ") : "*";
    const ro = spec.read_only ? " [read-only]" : "";
    lines.push(`- ${name}: ${spec.description} (Tools: ${toolsDesc})${ro}`);
  }

  lines.push(
    "",
    "When using the Agent tool, specify a subagent_type parameter to " +
    "select which agent type to use. If omitted, the general " +
    "agent is used.",
    "",
    "When NOT to use the Agent tool:",
    "- If you want to read a specific file path, use the Read tool or " +
    "the Glob tool instead of the Agent tool, to find the match more quickly",
    "- If you are searching for a specific class definition like " +
    "\"class Foo\", use the Glob tool instead",
    "- If you are searching for code within a specific file or set of " +
    "2-3 files, use the Read tool instead",
    "- Other tasks that are not related to the agent descriptions above",
    "",
    "Usage notes:",
    "- Launch multiple agents concurrently whenever possible, to " +
    "maximize performance; to do that, use a single message with " +
    "multiple tool uses",
    "- When the agent is done, it will return a single message back to " +
    "you. The result returned by the agent is not visible to the user. " +
    "To show the user the result, you should send a text message back " +
    "to the user with a concise summary of the result.",
    "- Each Agent invocation starts fresh — provide a complete task " +
    "description. The agent has no knowledge of the current conversation.",
    "- Clearly tell the agent whether you expect it to write code or " +
    "just to do research (search, file reads, etc.), since it is not " +
    "aware of the user's intent",
    "- The agent's outputs should generally be trusted",
  );
  return lines.join("\n");
}

export function makeAgentTool(opts: {
  queryEngine: QueryEngine;
  modelRegistry: ModelRegistry;
  toolRegistry: ToolRegistry;
  modelSelector: ModelSelector;
  permissionRules: PermissionRules;
  customAgents?: Record<string, AgentTypeSpec> | null;
}): Tool {
  const { queryEngine, modelRegistry, toolRegistry, modelSelector, permissionRules, customAgents } = opts;
  const custom = customAgents ?? {};
  const allTypes = getAgentTypes(custom);

  return buildTool({
    name: "agent",
    description: buildDescription(custom),
    search_hint: "agent description='search auth patterns' subagent_type=explore",
    is_destructive: false,
    inputSchema: z.object({
      description: z.string().describe("Short (3-5 word) description of the task"),
      prompt: z.string().describe("The task for the agent to perform"),
      subagent_type: z.string().optional().describe("Type of agent to use: general, explore, or plan"),
      run_in_background: z.boolean().optional().describe("Set to true to run this agent in the background. You will be notified when it completes."),
    }),
    async call(input, context) {
      const agentType = (input.subagent_type ?? "general").toLowerCase().trim();
      const spec = allTypes[agentType];
      if (!spec) {
        const available = Object.keys(allTypes).sort().join(", ");
        return `Error: unknown agent type '${input.subagent_type}'. Available: ${available}`;
      }

      if (input.run_in_background) {
        // Store pending results on the tool context.
        let pending = context._pending_background;
        if (!pending) {
          pending = [];
          (context as any)._pending_background = pending;
        }

        // Launch background task.
        const bgTask = async () => {
          const result = await runSubagent(input.prompt, agentType, {
            queryEngine,
            modelRegistry,
            toolRegistry,
            modelSelector,
            workingDir: context.working_dir,
            customAgents: custom,
          });
          pending!.push({ description: input.description, result });
        };

        // Fire-and-forget. In Node/Bun, we can use queueMicrotask or Promise.
        bgTask().catch(() => {});

        return (
          `Background agent launched: ${input.description}. ` +
          `You will be notified when it completes.`
        );
      }

      return await runSubagent(input.prompt, agentType, {
        queryEngine,
        modelRegistry,
        toolRegistry,
        modelSelector,
        workingDir: context.working_dir,
        eventCallback: context.event_callback as ((e: unknown) => void) | null,
        customAgents: custom,
      });
    },
  });
}
