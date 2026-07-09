/**
 * Tests for the web_fetch tool.
 * Ported from tests/test_web_fetch.py.
 */

import { describe, test, expect, beforeEach } from "bun:test";

import {
  webFetchTool,
  isBlockedHost,
  decodeContent,
  htmlToMarkdown,
  cache,
} from "../../src/tools/builtin/web_fetch.ts";

const ctx = () => ({ working_dir: "/tmp", read_cache: new Map() } as any);

// -- SSRF host blocking ------------------------------------------------------

describe("isBlockedHost", () => {
  test("blocks localhost / loopback", () => {
    expect(isBlockedHost("localhost")).toBe(true);
    expect(isBlockedHost("127.0.0.1")).toBe(true);
    expect(isBlockedHost("0.0.0.0")).toBe(true);
  });

  test("blocks private IP ranges", () => {
    expect(isBlockedHost("10.0.0.1")).toBe(true);
    expect(isBlockedHost("192.168.1.1")).toBe(true);
    expect(isBlockedHost("172.16.0.1")).toBe(true);
    expect(isBlockedHost("169.254.1.1")).toBe(true);
  });

  test("allows public hosts", () => {
    expect(isBlockedHost("example.com")).toBe(false);
    expect(isBlockedHost("docs.python.org")).toBe(false);
    expect(isBlockedHost("github.com")).toBe(false);
    expect(isBlockedHost("1.2.3.4")).toBe(false);
  });
});

// -- HTML to markdown --------------------------------------------------------

describe("htmlToMarkdown", () => {
  test("basic conversion", () => {
    const md = htmlToMarkdown("<h1>Title</h1><p>Hello <strong>world</strong></p>");
    // html-to-text uppercases headings; assert case-insensitively.
    expect(md.toLowerCase()).toContain("title");
    expect(md).toContain("world");
  });

  test("links", () => {
    const md = htmlToMarkdown('<a href="/docs">docs</a>');
    expect(md).toContain("docs");
    expect(md).toContain("/docs");
  });
});

// -- cache -------------------------------------------------------------------

describe("cache", () => {
  beforeEach(() => cache.clear());

  test("set and get", () => {
    cache.set("http://x.com/test", { ts: Date.now(), content: "cached content" });
    const entry = cache.get("http://x.com/test");
    expect(entry?.content).toBe("cached content");
  });

  test("miss returns undefined", () => {
    expect(cache.get("http://never-seen.com")).toBeUndefined();
  });
});

// -- input schema ------------------------------------------------------------

describe("input schema", () => {
  test("has url and prompt fields", () => {
    const schema = webFetchTool.inputSchema() as any;
    const props = schema.properties ?? schema;
    expect("url" in props).toBe(true);
    expect("prompt" in props).toBe(true);
  });
});

// -- decodeContent -----------------------------------------------------------

describe("decodeContent", () => {
  test("utf-8", () => {
    const result = decodeContent(new TextEncoder().encode("Hello 世界"));
    expect(result).toBe("Hello 世界");
  });

  test("gbk", () => {
    // "腾讯控股" in GBK
    const gbkBytes = Buffer.from([0xcc, 0xda, 0xd1, 0xb6, 0xbf, 0xd8, 0xb9, 0xc9]);
    const result = decodeContent(gbkBytes);
    expect(result).toBe("腾讯控股");
  });

  test("gb18030", () => {
    // gb18030 is a superset of gbk; the same bytes decode identically.
    const buf = Buffer.from([0xcc, 0xda, 0xd1, 0xb6, 0xbf, 0xd8, 0xb9, 0xc9]);
    const result = decodeContent(buf);
    expect(result).toBe("腾讯控股");
  });

  test("falls back for arbitrary bytes (never null on non-empty)", () => {
    const result = decodeContent(Buffer.from([0xff, 0xfe, 0x00, 0x01]));
    // latin-1 / non-fatal utf-8 always produces a string
    expect(result).not.toBeNull();
  });
});

// -- tool.call edge cases ---------------------------------------------------

describe("webFetchTool.call", () => {
  test("rejects empty url", async () => {
    const r: any = await webFetchTool.call({ url: "" }, ctx());
    expect(r.output).toContain("Error");
  });

  test("rejects blocked host", async () => {
    const r: any = await webFetchTool.call({ url: "http://localhost:8080/docs" }, ctx());
    expect(r.output.toLowerCase()).toContain("blocked");
  });
});
