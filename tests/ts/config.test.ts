import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  makeGlobalSettings,
  makeProviderConfig,
  resolveApiKey,
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
