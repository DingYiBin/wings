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

const DEFAULT_PERSONALITY = [
  "You are Wings, a multi-model AI agent CLI.",
  "",
  "You are an interactive agent that helps users with software engineering tasks.",
  "Use the instructions below and the tools available to you to assist the user.",
].join("\n");

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
  let settings: GlobalSettingsData;
  if (projectData) {
    const merged = { ...global } as unknown as Record<string, unknown>;
    deepMerge(merged, projectData);
    settings = merged as unknown as GlobalSettingsData;
  } else {
    settings = global;
  }

  // Environment variables override everything (matching Python's pydantic
  // BaseSettings: env_prefix="WINGS_", env_nested_delimiter="__"). Env wins
  // over both global and project config. See applyEnvOverrides for coverage.
  applyEnvOverrides(settings);
  return settings;
}

/**
 * Apply WINGS_-prefixed environment variable overrides to loaded settings,
 * mirroring pydantic's BaseSettings (env_prefix="WINGS_",
 * env_nested_delimiter="__"). Env wins over file config.
 *
 * Covered: scalar top-level fields (theme, model, personality), list fields
 * (allowed_tools, denied_tools — comma-separated), and nested dict fields
 * (providers/<name>/<field>, routing, hooks, mcp_servers). Provider api_key
 * is also resolved at call time via resolveApiKey, but setting it here keeps
 * the providers dict consistent.
 */
function applyEnvOverrides(settings: GlobalSettingsData): void {
  // Top-level scalars / lists.
  const scalar: Array<[keyof GlobalSettingsData, "string" | "string[]"]> = [
    ["theme", "string"],
    ["model", "string"],
    ["personality", "string"],
    ["allowed_tools", "string[]"],
    ["denied_tools", "string[]"],
  ];
  for (const [field, kind] of scalar) {
    const envName = `WINGS_${field.toUpperCase()}`;
    const raw = process.env[envName];
    if (raw === undefined) continue;
    if (kind === "string") {
      (settings[field] as unknown as string) = raw;
    } else {
      (settings[field] as unknown as string[]) = raw.split(",").map((s) => s.trim()).filter(Boolean);
    }
  }

  // Nested dict fields: <field>__<key>__... = value.
  const nested: Array<keyof GlobalSettingsData> = ["providers", "routing", "hooks", "mcp_servers"];
  for (const field of nested) {
    const prefix = `WINGS_${field.toUpperCase()}__`;
    for (const [envName, value] of Object.entries(process.env)) {
      if (!envName.startsWith(prefix) || value === undefined) continue;
      const path = envName.slice(prefix.length).toLowerCase().split("__");
      // Coerce numeric/boolean values for known provider fields.
      let coerced: unknown = value;
      const leafKey = path[path.length - 1];
      if (leafKey === "max_tokens" || leafKey === "escalated_max_tokens" || leafKey === "context_window" || leafKey === "thinking_budget") {
        coerced = Number(value);
      } else if (leafKey === "thinking") {
        coerced = value === "true" || value === "1";
      }
      setNested(settings[field] as Record<string, unknown>, path, coerced);
    }
  }
}

/** Set a value at a dot-path inside a (possibly absent) nested dict, creating
 * intermediate dicts as needed. */
function setNested(root: Record<string, unknown>, path: string[], value: unknown): void {
  let node = root;
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i]!;
    if (typeof node[k] !== "object" || node[k] === null || Array.isArray(node[k])) {
      node[k] = {};
    }
    node = node[k] as Record<string, unknown>;
  }
  node[path[path.length - 1]!] = value;
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
