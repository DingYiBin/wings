/** Tests for routing — global pool + score masks + softmax selection. */

import { describe, expect, test } from "bun:test";
import {
  APIPoolManager,
  NEG_INF,
  NoAPIAvailable,
  PoolConfig,
  PoolEntry,
  TASK_HIERARCHY,
  resolveParent,
  softmaxSelect,
} from "../../src/routing/index.ts";

// -- softmax_select ---------------------------------------------------------

describe("softmaxSelect", () => {
  test("single entry returns that entry", () => {
    const entries: PoolEntry[] = [{ api_id: "a", score: 0 }];
    expect(softmaxSelect(entries)).toBe("a");
  });

  test("disabled (-inf) mask delta excludes the API", () => {
    const entries: PoolEntry[] = [
      { api_id: "a", score: 0 },
      { api_id: "b", score: 0 },
    ];
    // Override Math.random to deterministic value.
    const orig = Math.random;
    Math.random = () => 0.42;
    try {
      const result = softmaxSelect(entries, { a: NEG_INF });
      expect(result).toBe("b");
    } finally {
      Math.random = orig;
    }
  });

  test("higher score is exponentially more likely", () => {
    const entries: PoolEntry[] = [
      { api_id: "a", score: 0 },
      { api_id: "b", score: 0 },
    ];
    const counts: Record<string, number> = { a: 0, b: 0 };
    for (let i = 0; i < 10000; i++) {
      counts[softmaxSelect(entries, { a: 2 })]!++;
    }
    // a has exp(2) ≈ 7.4x more weight
    expect(counts.a!).toBeGreaterThan(counts.b! * 2);
  });

  test("all disabled throws NoAPIAvailable", () => {
    const entries: PoolEntry[] = [{ api_id: "a", score: 0 }];
    expect(() => softmaxSelect(entries, { a: NEG_INF })).toThrow(NoAPIAvailable);
  });

  test("empty entries throws NoAPIAvailable", () => {
    expect(() => softmaxSelect([], null)).toThrow(NoAPIAvailable);
  });

  test("no mask → uniform probabilities", () => {
    const entries: PoolEntry[] = [
      { api_id: "a", score: 0 },
      { api_id: "b", score: 0 },
    ];
    const result = softmaxSelect(entries);
    expect(["a", "b"]).toContain(result);
  });

  test("negative adjustment reduces probability", () => {
    // a at -5 should almost never be selected vs b at 0.
    // exp(-5) / (exp(0) + exp(-5)) ≈ 0.007
    const entries: PoolEntry[] = [
      { api_id: "a", score: 0 },
      { api_id: "b", score: 0 },
    ];
    const counts: Record<string, number> = { a: 0, b: 0 };
    for (let i = 0; i < 10000; i++) {
      counts[softmaxSelect(entries, { a: -5 })]!++;
    }
    expect(counts.b!).toBeGreaterThan(counts.a! * 10);
  });
});

// -- resolve_parent ---------------------------------------------------------

describe("resolveParent", () => {
  test("static hierarchy", () => {
    expect(resolveParent("subagent/explore")).toBe("subagent");
    expect(resolveParent("main")).toBeNull();
  });

  test("skill/* resolves to subagent/skill", () => {
    expect(resolveParent("skill/commit")).toBe("subagent/skill");
  });

  test("unknown resolves to null", () => {
    expect(resolveParent("custom/type")).toBeNull();
  });

  test("root types have no parent", () => {
    for (const root of ["main", "subagent", "continuous", "background"]) {
      expect(TASK_HIERARCHY[root]).toBeNull();
    }
  });

  test("all hierarchy values are valid keys", () => {
    for (const [child, parent] of Object.entries(TASK_HIERARCHY)) {
      if (parent !== null) {
        expect(TASK_HIERARCHY).toHaveProperty(parent);
      }
    }
  });
});

// -- APIPoolManager: selection ----------------------------------------------

describe("APIPoolManager selection", () => {
  test("override bypasses pool", () => {
    const mgr = new APIPoolManager();
    mgr.registerApi("api-a");
    expect(mgr.select("main", "forced")).toBe("forced");
  });

  test("select from global pool", () => {
    const mgr = new APIPoolManager();
    mgr.registerApi("api-a");
    mgr.registerApi("api-b");
    const result = mgr.select("main");
    expect(["api-a", "api-b"]).toContain(result);
  });

  test("empty pool throws", () => {
    const mgr = new APIPoolManager();
    expect(() => mgr.select("main")).toThrow(NoAPIAvailable);
  });

  test("all disabled throws", () => {
    const mgr = new APIPoolManager();
    mgr.registerApi("api-a");
    mgr.disable("main", "api-a");
    expect(() => mgr.select("main")).toThrow(NoAPIAvailable);
  });
});

// -- APIPoolManager: registration -------------------------------------------

describe("APIPoolManager registration", () => {
  test("registerApi adds to global pool", () => {
    const mgr = new APIPoolManager();
    mgr.registerApi("api-x");
    expect(mgr.listApis()).toContain("api-x");
  });

  test("unregisterApi removes from pool and masks", () => {
    const mgr = new APIPoolManager();
    mgr.registerApi("api-x");
    mgr.disable("main", "api-x");
    mgr.unregisterApi("api-x");
    expect(mgr.listApis()).not.toContain("api-x");
    expect(mgr.getMask("main")).not.toHaveProperty("api-x");
  });
});

// -- APIPoolManager: score adjustments --------------------------------------

describe("APIPoolManager score adjustments", () => {
  test("upvote increases mask delta", () => {
    const mgr = new APIPoolManager();
    mgr.registerApi("api-x");
    mgr.upvote("main", "api-x", 0.5);
    expect(mgr.getMask("main")["api-x"]).toBe(0.5);
  });

  test("downvote decreases mask delta", () => {
    const mgr = new APIPoolManager();
    mgr.registerApi("api-x");
    mgr.downvote("main", "api-x", 0.5);
    expect(mgr.getMask("main")["api-x"]).toBe(-0.5);
  });

  test("adjustScore exact", () => {
    const mgr = new APIPoolManager();
    mgr.registerApi("api-x");
    mgr.adjustScore("main", "api-x", 3.0);
    expect(mgr.getMask("main")["api-x"]).toBe(3.0);
  });

  test("adjustBaseScore changes global score", () => {
    const mgr = new APIPoolManager();
    mgr.registerApi("api-x");
    mgr.adjustBaseScore("api-x", 2.0);
    mgr.registerApi("api-y");
    // api-x at 2.0 should dominate api-y at 0.0
    const counts: Record<string, number> = { "api-x": 0, "api-y": 0 };
    for (let i = 0; i < 1000; i++) {
      counts[mgr.select("main")]!++;
    }
    expect(counts["api-x"]!).toBeGreaterThan(counts["api-y"]! * 2);
  });

  test("disable excludes", () => {
    const mgr = new APIPoolManager();
    mgr.registerApi("api-x");
    mgr.registerApi("api-y");
    mgr.disable("main", "api-x");
    for (let i = 0; i < 50; i++) {
      expect(mgr.select("main")).toBe("api-y");
    }
  });

  test("enable re-includes", () => {
    const mgr = new APIPoolManager();
    mgr.registerApi("api-x");
    mgr.registerApi("api-y");
    mgr.disable("main", "api-x");
    mgr.enable("main", "api-x");
    const found = new Set<string>();
    for (let i = 0; i < 50; i++) found.add(mgr.select("main"));
    expect(found.has("api-x")).toBe(true);
  });
});

// -- APIPoolManager: masks + inheritance ------------------------------------

describe("APIPoolManager mask inheritance", () => {
  test("subagent/explore inherits subagent mask", () => {
    const mgr = new APIPoolManager();
    mgr.registerApi("api-a");
    mgr.registerApi("api-b");
    mgr.disable("subagent", "api-b");
    // subagent/explore has no mask → inherits subagent mask
    for (let i = 0; i < 50; i++) {
      expect(mgr.select("subagent/explore")).toBe("api-a");
    }
  });

  test("child mask overrides parent", () => {
    const mgr = new APIPoolManager();
    mgr.registerApi("api-a");
    mgr.registerApi("api-b");
    mgr.disable("subagent", "api-a");
    // Child explicitly enables api-a (overrides parent disable)
    mgr.adjustScore("subagent/explore", "api-a", 0);
    mgr.disable("subagent/explore", "api-b");
    for (let i = 0; i < 50; i++) {
      expect(mgr.select("subagent/explore")).toBe("api-a");
    }
  });

  test("forkMask copies parent mask", () => {
    const mgr = new APIPoolManager();
    mgr.registerApi("api-a");
    mgr.registerApi("api-b");
    mgr.disable("subagent", "api-b");
    mgr.forkMask("skill/commit", "subagent");
    for (let i = 0; i < 50; i++) {
      expect(mgr.select("skill/commit")).toBe("api-a");
    }
  });
});

// -- APIPoolManager: persistence --------------------------------------------

describe("APIPoolManager persistence", () => {
  test("to_config round-trip", () => {
    const mgr = new APIPoolManager();
    mgr.registerApi("api-a");
    mgr.registerApi("api-b", { score: 1.0 });
    mgr.upvote("main", "api-a", 2.0);
    mgr.disable("subagent", "api-b");

    const config: PoolConfig = mgr.toConfig();
    expect(config.version).toBe(2);
    expect(config.apis).toHaveLength(2);

    const restored = new APIPoolManager(config);
    expect(new Set(restored.listApis())).toEqual(new Set(["api-a", "api-b"]));
    expect(restored.getMask("main")["api-a"]).toBe(2.0);
    expect(restored.getMask("subagent")["api-b"]).toBe(NEG_INF);
  });

  test("replace_config", () => {
    const config: PoolConfig = {
      version: 2,
      apis: [{ api_id: "x", score: 5.0 }],
      masks: { main: { x: 1.0 } },
    };
    const mgr = new APIPoolManager(config);
    expect(mgr.listApis()).toEqual(["x"]);
    expect(mgr.getMask("main")["x"]).toBe(1.0);
  });

  test("list_task_types", () => {
    const mgr = new APIPoolManager();
    mgr.registerApi("api-x");
    mgr.upvote("main", "api-x", 1.0);
    expect(mgr.listTaskTypes()).toContain("main");
  });
});
