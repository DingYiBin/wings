/**
 * Custom agent loader — discovers .wings/agents/*.md files.
 *
 * Format: YAML frontmatter + markdown body (same as SKILL.md).
 * Custom agents merge on top of built-in types — project agents override
 * built-in agents with the same name.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { AgentTypeSpec } from "./subagent.ts";

const FRONTMATTER_RE = /^---\s*\n(.*?)\n---\s*\n?(.*)/s;

function parseAgentFile(path: string): AgentTypeSpec | null {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return null;
  }

  const m = FRONTMATTER_RE.exec(text);
  if (!m) return null;

  let meta: unknown;
  try {
    meta = parseYaml(m[1]!);
  } catch {
    return null;
  }
  if (!meta || typeof meta !== "object" || !("name" in meta)) return null;

  const name = String(meta["name"]).toLowerCase().trim();
  const body = m[2]?.trim() ?? "";
  const description = String(
    (meta as any)["description"] ?? body.slice(0, 200),
  );

  // YAML may load tools as list or string.
  let tools: string[] | null = null;
  const toolsRaw = (meta as any)["tools"];
  if (toolsRaw === undefined || toolsRaw === null) {
    tools = null; // null = all
  } else if (Array.isArray(toolsRaw)) {
    tools = toolsRaw.map(String);
  } else {
    tools = String(toolsRaw)
      .split(",")
      .map((s: string) => s.trim());
  }

  let disallowed: string[] = [];
  const disallowedRaw = (meta as any)["disallowed_tools"] ?? [];
  if (Array.isArray(disallowedRaw)) {
    disallowed = disallowedRaw.map(String);
  } else {
    disallowed = String(disallowedRaw)
      .split(",")
      .map((s: string) => s.trim());
  }

  // Always disallow agent tool for custom agents.
  if (!disallowed.includes("agent")) disallowed.push("agent");

  const taskType = `subagent/${name}`;

  return {
    name,
    description,
    tools,
    disallowed_tools: disallowed,
    read_only: !!(meta as any)["read_only"],
    task_type: taskType,
  };
}

export function loadCustomAgents(
  projectDir: string,
): Record<string, AgentTypeSpec> {
  const agentsDir = join(projectDir, ".wings", "agents");
  if (!existsSync(agentsDir)) return {};

  const custom: Record<string, AgentTypeSpec> = {};
  let entries: string[];
  try {
    entries = readdirSync(agentsDir, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith(".md"))
      .map((d) => d.name)
      .sort();
  } catch {
    return {};
  }

  for (const fileName of entries) {
    const spec = parseAgentFile(join(agentsDir, fileName));
    if (spec) {
      custom[spec.name] = spec;
    }
  }
  return custom;
}
