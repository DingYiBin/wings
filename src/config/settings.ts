/**
 * Layered configuration: .wings/config.json > ~/.wings/config.json > defaults.
 *
 * Project-level .wings/config.json overrides global ~/.wings/config.json
 * for overlapping keys. Both files share the same schema.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import type { PoolConfig } from "../routing/types.ts";
import { makePoolConfig } from "../routing/types.ts";

// -- Default system prompt --

const DEFAULT_PERSONALITY = `You are Wings, a multi-model AI agent CLI.

You are an interactive agent that helps users with software engineering tasks. Use the instructions below and the tools available to you to assist the user.

IMPORTANT: Assist with authorized security testing, defensive security, CTF challenges, and educational contexts. Refuse requests for destructive techniques, DoS attacks, mass targeting, supply chain compromise, or detection evasion for malicious purposes. Dual-use security tools (C2 frameworks, credential testing, exploit development) require clear authorization context: pentesting engagements, CTF competitions, security research, or defensive use cases.
IMPORTANT: You must NEVER generate or guess URLs for the user unless you are confident that the URLs are for helping the user with programming. You may use URLs provided by the user in their messages or local files.`;

// -- Provider config --

export interface ProviderConfig {
  model: string;
  protocol: string; // "anthropic" or "openai"
  api_key: string;
  base_url: string;
  max_tokens: number;
  escalated_max_tokens: number;
  thinking: boolean;
  thinking_budget: number | null;
  context_window: number;
}

export function makeProviderConfig(init: Partial<ProviderConfig> & { base_url: string }): ProviderConfig {
  return {
    model: "claude-sonnet-4-6",
    protocol: "anthropic",
    api_key: "",
    max_tokens: 8_000,
    escalated_max_tokens: 64_000,
    thinking: true,
    thinking_budget: null,
    context_window: 200_000,
    ...init,
  };
}

// -- Global Settings --

export interface GlobalSettingsData {
  providers: Record<string, ProviderConfig>;
  routing: PoolConfig;
  theme: "dark" | "light";
  model: string | null;
  personality: string;
  allowed_tools: string[];
  denied_tools: string[];
  hooks: Record<string, Array<Record<string, unknown>>>;
  mcp_servers: Record<string, Record<string, unknown>>;
}

export function makeGlobalSettings(
  init: Partial<GlobalSettingsData> = {},
): GlobalSettingsData {
  return {
    providers: init.providers ?? {},
    routing: init.routing ?? makePoolConfig(),
    theme: init.theme ?? "dark",
    model: init.model ?? null,
    personality: init.personality ?? DEFAULT_PERSONALITY,
    allowed_tools: init.allowed_tools ?? [],
    denied_tools: init.denied_tools ?? [],
    hooks: init.hooks ?? {},
    mcp_servers: init.mcp_servers ?? {},
  };
}

/** Deep merge override into base in-place. Nested dicts merged recursively. */
function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(override)) {
    if (
      key in base &&
      typeof base[key] === "object" &&
      base[key] !== null &&
      !Array.isArray(base[key]) &&
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value)
    ) {
      deepMerge(base[key] as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      base[key] = value;
    }
  }
}

function loadJsonFile(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function findProjectConfig(directory: string): Record<string, unknown> | null {
  let current = directory;
  for (let i = 0; i < 20; i++) {
    const jsonPath = join(current, ".wings", "config.json");
    const data = loadJsonFile(jsonPath);
    if (data) return data;
    const parent = join(current, "..");
    if (parent === current) break;
    current = parent;
  }
  return null;
}

export function loadGlobalSettings(
  globalPath?: string,
): GlobalSettingsData {
  const path = globalPath ?? join(homedir(), ".wings", "config.json");
  const jsonData = loadJsonFile(path) ?? {};
  return makeGlobalSettings(jsonData as Partial<GlobalSettingsData>);
}

export function loadSettings(
  workingDir?: string,
): GlobalSettingsData {
  const cwd = workingDir ?? process.cwd();
  const global = loadGlobalSettings();

  // Walk up to find project config.
  const projectData = findProjectConfig(cwd);
  if (projectData) {
    const merged = { ...global } as unknown as Record<string, unknown>;
    deepMerge(merged, projectData);
    return merged as unknown as GlobalSettingsData;
  }

  return global;
}

export function resolveApiKey(
  settings: GlobalSettingsData,
  provider: string,
): string {
  const envKey = process.env[`WINGS_PROVIDERS__${provider.toUpperCase()}__API_KEY`];
  if (envKey) return envKey;
  const cfg = settings.providers[provider];
  return cfg?.api_key ?? "";
}
