/**
 * Bootstrap wiring — create a fully configured agent session.
 *
 * This is the "composition root" where all modules are wired together.
 */

import { cwd } from "node:process";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

import { AgentContext, AgentLoop } from "../agent/loop.ts";
import { loadCustomAgents } from "../agent/agent_loader.ts";
import { BUILTIN_AGENT_TYPES, getAgentTypes, type AgentTypeSpec } from "../agent/subagent.ts";
import {
  loadSettings,
  resolveApiKey,
  type GlobalSettingsData,
} from "../config/settings.ts";
import { makeModelConfig } from "../models/protocol.ts";
import { HookRunner } from "../hooks/runner.ts";
import { loadMCPServers } from "../mcp/loader.ts";
import { loadMemoryPrompt } from "../memory/loader.ts";
import { maybeExtractMemories } from "../memory/extractor.ts";
import { AnthropicProvider } from "../models/anthropic.ts";
import { OpenAIProvider } from "../models/openai.ts";
import { ModelRegistry } from "../models/registry.ts";
import { PermissionPipeline } from "../permissions/pipeline.ts";
import { PermissionRules } from "../permissions/rules.ts";
import { QueryEngine } from "../query/engine.ts";
import { APIPoolManager } from "../routing/manager.ts";
import type { ModelSelector } from "../routing/protocol.ts";
import { SkillLoader } from "../skills/loader.ts";
import type { SkillSpec } from "../skills/types.ts";
import { makeToolContext, type Tool } from "../tools/types.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { makeAgentTool } from "../tools/builtin/agent.ts";
import {
  bashTool,
  editTool,
  globTool,
  grepTool,
  readTool,
  skillViewTool,
  webFetchTool,
  webSearchTool,
  writeTool,
} from "../tools/builtin/index.ts";

// Provider protocol adapter map.
async function createProvider(protocol: string) {
  if (protocol === "anthropic") return new AnthropicProvider();
  if (protocol === "openai") return new OpenAIProvider();
  return null;
}

export async function createSession(
  workingDir?: string,
  logger?: { recordCycle(opts: Record<string, unknown>): void } | null,
): Promise<{ loop: AgentLoop; config: GlobalSettingsData; poolMgr: APIPoolManager }> {
  const wd = workingDir ?? cwd();
  const config = loadSettings(wd);

  // -- API pool manager --
  const poolMgr = new APIPoolManager(config.routing);

  // -- Model registry --
  const registry = new ModelRegistry(poolMgr);

  // Register all configured providers that have API keys.
  for (const [name, cfg] of Object.entries(config.providers)) {
    const provider = await createProvider(cfg.protocol);
    if (!provider) continue;
    const apiKey = resolveApiKey(config, name);
    if (!apiKey) continue;

    const apiId = `${name}/${cfg.model}`;
    const modelConfig = makeModelConfig({
      model: cfg.model,
      api_key: apiKey,
      base_url: cfg.base_url,
      max_tokens: cfg.max_tokens,
      escalated_max_tokens: cfg.escalated_max_tokens,
      thinking: cfg.thinking,
      thinking_budget: cfg.thinking_budget,
      context_window: cfg.context_window,
    });
    registry.register(apiId, provider, { config: modelConfig });
    poolMgr.registerApi(apiId);
  }

  // -- Skills --
  const userSkillsDir = join(homedir(), ".wings", "skills");
  const projectSkillsDir = join(wd, ".wings", "skills");
  // builtin skills — look relative to this file's package.
  const builtinDir = join(import.meta.dirname!, "..", "..", "skills", "builtin");
  const loader = new SkillLoader({
    userDir: userSkillsDir,
    projectDir: projectSkillsDir,
    builtinDir,
  });
  const skillsList = loader.loadAll();
  const availableSkills: Record<string, string> = {};
  for (const s of skillsList) {
    availableSkills[s.name] = s.content;
  }

  // Fork API pool per skill.
  for (const skill of skillsList) {
    poolMgr.forkMask(`skill/${skill.name}`, "subagent/skill");
  }

  // -- Tool registry --
  const tools = new ToolRegistry();
  const builtins = [readTool, writeTool, editTool, bashTool, globTool, grepTool, skillViewTool, webFetchTool, webSearchTool];
  for (const t of builtins) tools.register(t);

  // Apply project-level tool filters.
  if (config.denied_tools) {
    tools.filterDenied(config.denied_tools);
  }

  // -- Permissions --
  const rules = new PermissionRules();
  for (const name of config.allowed_tools) rules.addAllow(name);
  for (const name of config.denied_tools) rules.addDeny(name);

  // -- Hooks --
  const hookRunner = new HookRunner(config.hooks);
  const pipeline = new PermissionPipeline(rules, hookRunner.hasHooks() ? hookRunner : null);

  // -- Query engine --
  const engine = new QueryEngine(registry);

  // -- MCP tools --
  if (config.mcp_servers && Object.keys(config.mcp_servers).length > 0) {
    try {
      await loadMCPServers(tools, config.mcp_servers);
    } catch {
      // MCP loading is best-effort.
    }
  }

  // -- Agent tool (subagent support) --
  const customAgents = loadCustomAgents(wd);
  const agentTool = makeAgentTool({
    queryEngine: engine,
    modelRegistry: registry,
    toolRegistry: tools,
    modelSelector: poolMgr,
    permissionRules: rules,
    customAgents,
  });
  tools.register(agentTool);

  // -- Agent loop --
  const loop = new AgentLoop(engine, tools, pipeline, poolMgr, registry);
  if (logger) loop.setLogger(logger);
  (loop as any).skillLoader = loader;
  (loop as any).availableSkills = availableSkills;
  (loop as any).poolManager = poolMgr;
  (loop as any).customAgents = customAgents;

  // Memory extraction callback — called from the CLI after each turn.
  // Runs a memory-extractor subagent every 5 turns (mirrors Python bootstrap).
  let turnCount = 0;
  (loop as any).extractMemories = async (messagesText: string): Promise<void> => {
    turnCount += 1;
    if (turnCount % 5 !== 0) return;
    try {
      await maybeExtractMemories(messagesText, {
        workingDir: wd,
        queryEngine: engine,
        modelRegistry: registry,
        toolRegistry: tools,
        modelSelector: poolMgr,
      });
    } catch {
      // Memory extraction is best-effort — never fail the chat turn.
    }
  };

  return { loop, config, poolMgr };
}

export function makeAgentContext(
  config: GlobalSettingsData,
  opts: {
    taskType?: string;
    modelOverride?: string | null;
    workingDir?: string;
    skills?: SkillSpec[];
    availableSkills?: Record<string, string>;
  } = {},
): AgentContext {
  const wd = opts.workingDir ?? cwd();
  const skills = opts.skills ?? [];
  let systemPrompt = config.personality;

  // Core behavioral guidelines.
  systemPrompt += [
    "",
    "## Guidelines",
    "- Work autonomously — use tools to gather information, then answer.",
    "- For time-sensitive queries: 2-3 search attempts are enough.",
    "- If web_fetch returns 403 or timeout twice from the same domain, stop.",
    "- When you have enough information to give a useful answer, answer directly.",
  ].join("\n");

  // Inject available skills.
  if (skills.length > 0) {
    const skillLines = skills
      .filter((s) => !s.disable_model_invocation)
      .map((s) => `- ${s.name}: ${s.description || s.content.slice(0, 200)}`);
    systemPrompt += "\n\n## Available Skills\n" + skillLines.join("\n");
  }

  // Inject available agents.
  const allAgents = getAgentTypes(BUILTIN_AGENT_TYPES as Record<string, AgentTypeSpec>);
  const agentLines = ["\n## Available Agents"];
  for (const [name, spec] of Object.entries(allAgents).sort()) {
    const toolsDesc = spec.tools ? spec.tools.join(", ") : "all";
    const ro = spec.read_only ? " [read-only]" : "";
    agentLines.push(`- **${name}**: ${spec.description} (Tools: ${toolsDesc})${ro}`);
  }
  agentLines.push("\nUse agent(subagent_type=\"<name>\", description=\"...\", prompt=\"...\") to spawn one.");
  systemPrompt += "\n" + agentLines.join("\n");

  // Inject memory (MEMORY.md from .wings/memory/).
  systemPrompt += "\n\n" + loadMemoryPrompt(wd);

  // Environment info.
  systemPrompt += [
    "",
    "# Environment",
    `Working directory: ${wd}`,
    `Current date: ${new Date().toISOString().slice(0, 10)}`,
  ].join("\n");

  return new AgentContext({
    task_type: opts.taskType ?? "main",
    model_override: opts.modelOverride ?? config.model,
    tool_context: makeToolContext({
      working_dir: wd,
      available_skills: opts.availableSkills ?? {},
    }),
    system_prompt: systemPrompt,
  });
}
