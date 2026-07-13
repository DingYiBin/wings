import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  makeGlobalSettings,
  makeProviderConfig,
  resolveApiKey,
  applyEnvOverrides,
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
});

describe("applyEnvOverrides", () => {
  // Tracks env keys set during a test so afterEach can restore them.
  let touched: Array<[string, string | undefined]> = [];
  function setEnv(key: string, value: string) {
    touched.push([key, process.env[key]]);
    process.env[key] = value;
  }
  beforeEach(() => { touched = []; });
  afterEach(() => {
    for (const [k, v] of touched) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test("overrides scalar fields (theme, model, personality)", () => {
    setEnv("WINGS_THEME", "light");
    setEnv("WINGS_MODEL", "anthropic/claude-x");
    setEnv("WINGS_PERSONALITY", "custom persona");
    const s = applyEnvOverrides(makeGlobalSettings());
    expect(s.theme).toBe("light");
    expect(s.model).toBe("anthropic/claude-x");
    expect(s.personality).toBe("custom persona");
  });

  test("overrides nested provider fields with type coercion", () => {
    setEnv("WINGS_PROVIDERS__MYPROV__API_KEY", "sk-env");
    setEnv("WINGS_PROVIDERS__MYPROV__MAX_TOKENS", "12345");
    setEnv("WINGS_PROVIDERS__MYPROV__THINKING", "false");
    const s = applyEnvOverrides(makeGlobalSettings());
    expect(s.providers["myprov"]!.api_key).toBe("sk-env");
    expect(s.providers["myprov"]!.max_tokens).toBe(12345);
    expect(s.providers["myprov"]!.thinking).toBe(false);
  });

  test("parses list fields from comma-separated values", () => {
    setEnv("WINGS_ALLOWED_TOOLS", "bash, read, glob");
    const s = applyEnvOverrides(makeGlobalSettings());
    expect(s.allowed_tools).toEqual(["bash", "read", "glob"]);
  });

  test("does not mutate the input settings", () => {
    const original = makeGlobalSettings();
    setEnv("WINGS_THEME", "light");
    applyEnvOverrides(original);
    expect(original.theme).toBe("dark");
  });
});
