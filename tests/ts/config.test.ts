import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  makeGlobalSettings,
  makeProviderConfig,
  resolveApiKey,
  loadSettings,
} from "../../src/config/settings.ts";

describe("Config", () => {
  test("provider config defaults", () => {
    const pc = makeProviderConfig({ base_url: "https://api.example.com" });
    expect(pc.model).toBe("claude-sonnet-4-6");
    expect(pc.protocol).toBe("anthropic");
    expect(pc.max_tokens).toBe(8_000);
    expect(pc.thinking).toBe(true);
  });

  test("global settings defaults", () => {
    const s = makeGlobalSettings();
    expect(s.theme).toBe("dark");
    expect(s.model).toBeNull();
    expect(s.personality).toBeTruthy();
    expect(s.allowed_tools).toEqual([]);
    expect(s.denied_tools).toEqual([]);
  });

  test("resolveApiKey prefers env var", () => {
    const old = process.env["WINGS_PROVIDERS__TEST__API_KEY"];
    process.env["WINGS_PROVIDERS__TEST__API_KEY"] = "env-key";
    const s = makeGlobalSettings({
      providers: {
        test: makeProviderConfig({ base_url: "https://x.com", api_key: "cfg-key" }),
      },
    });
    expect(resolveApiKey(s, "test")).toBe("env-key");
    if (old) process.env["WINGS_PROVIDERS__TEST__API_KEY"] = old;
    else delete process.env["WINGS_PROVIDERS__TEST__API_KEY"];
  });

  test("resolveApiKey falls back to config", () => {
    const s = makeGlobalSettings({
      providers: {
        test: makeProviderConfig({ base_url: "https://x.com", api_key: "cfg-key" }),
      },
    });
    expect(resolveApiKey(s, "test")).toBe("cfg-key");
  });

  test("resolveApiKey returns empty for unknown", () => {
    expect(resolveApiKey(makeGlobalSettings(), "unknown")).toBe("");
  });

  test("env vars override project config (env > config > default)", () => {
    const dir = mkdtempSync(join(tmpdir(), "wings-env-"));
    mkdirSync(join(dir, ".wings"));
    writeFileSync(join(dir, ".wings", "config.json"), JSON.stringify({
      theme: "light",
      model: "config-model",
      allowed_tools: ["read"],
      providers: { anthropic: { model: "claude-x", base_url: "https://x", api_key: "cfg-key", max_tokens: 8000 } },
    }));
    // Save & clear WINGS_ env, then set overrides.
    const saved: Record<string, string | undefined> = {};
    for (const k of Object.keys(process.env)) if (k.startsWith("WINGS_")) { saved[k] = process.env[k]; delete process.env[k]; }
    process.env["WINGS_THEME"] = "dark";
    process.env["WINGS_MODEL"] = "env-model";
    process.env["WINGS_ALLOWED_TOOLS"] = "read,write,bash";
    process.env["WINGS_PROVIDERS__ANTHROPIC__API_KEY"] = "env-key";
    process.env["WINGS_PROVIDERS__ANTHROPIC__MAX_TOKENS"] = "16000";
    process.env["WINGS_PROVIDERS__ANTHROPIC__THINKING"] = "false";

    try {
      const s = loadSettings(dir);
      expect(s.theme).toBe("dark");                       // env > config
      expect(s.model).toBe("env-model");                  // env > config
      expect(s.allowed_tools).toEqual(["read", "write", "bash"]); // env list
      expect(s.providers.anthropic!.api_key).toBe("env-key");     // env nested
      expect(s.providers.anthropic!.max_tokens).toBe(16000);      // env number coerce
      expect(s.providers.anthropic!.thinking).toBe(false);        // env bool coerce
      expect(s.providers.anthropic!.model).toBe("claude-x");      // config, no env
    } finally {
      // Restore env.
      for (const k of Object.keys(process.env)) if (k.startsWith("WINGS_")) delete process.env[k];
      for (const [k, v] of Object.entries(saved)) { if (v !== undefined) process.env[k] = v; }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no env vars: project config wins", () => {
    const dir = mkdtempSync(join(tmpdir(), "wings-noenv-"));
    mkdirSync(join(dir, ".wings"));
    writeFileSync(join(dir, ".wings", "config.json"), JSON.stringify({
      theme: "light",
      providers: { anthropic: { base_url: "https://x", api_key: "cfg-key" } },
    }));
    const saved: Record<string, string | undefined> = {};
    for (const k of Object.keys(process.env)) if (k.startsWith("WINGS_")) { saved[k] = process.env[k]; delete process.env[k]; }
    try {
      const s = loadSettings(dir);
      expect(s.theme).toBe("light");
      expect(s.providers.anthropic!.api_key).toBe("cfg-key");
    } finally {
      for (const k of Object.keys(process.env)) if (k.startsWith("WINGS_")) delete process.env[k];
      for (const [k, v] of Object.entries(saved)) { if (v !== undefined) process.env[k] = v; }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
