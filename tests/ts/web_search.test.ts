/** Tests for web_search — Bing fallback chain and HTML parsing. */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { webSearchTool, parseBingHtml } from "../../src/tools/builtin/web_search.ts";

const ctx = { working_dir: process.cwd() } as never;

const originalFetch = globalThis.fetch;

function mockFetch(handler: (url: string) => { ok: boolean; text: string }): void {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const r = handler(url);
    return Promise.resolve(
      new Response(r.text, { status: r.ok ? 200 : 500 }),
    );
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("parseBingHtml", () => {
  test("parses b_algo result items into title/href/body", () => {
    const html = [
      '<li class="b_algo">',
      "<h2><a href=\"https://example.com/a\">First Result</a></h2>",
      "<p>First snippet text</p>",
      "</li>",
      '<li class="b_algo">',
      "<h2><a href=\"https://example.com/b\">Second Result</a></h2>",
      "<p>Second snippet</p>",
      "</li>",
    ].join("");
    const results = parseBingHtml(html, 10);
    expect(results.length).toBe(2);
    expect(results[0]!.title).toBe("First Result");
    expect(results[0]!.href).toBe("https://example.com/a");
    expect(results[0]!.body).toBe("First snippet text");
    expect(results[1]!.title).toBe("Second Result");
  });

  test("respects maxResults cap", () => {
    const html = Array.from({ length: 5 }, (_, i) =>
      `<li class="b_algo"><h2><a href="https://x/${i}">T${i}</a></h2><p>s</p></li>`,
    ).join("");
    expect(parseBingHtml(html, 2).length).toBe(2);
  });

  test("skips items without a link", () => {
    const html = '<li class="b_algo"><h2>no link here</h2><p>body</p></li>';
    expect(parseBingHtml(html, 10)).toEqual([]);
  });
});

describe("web_search fallback chain", () => {
  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("uses DuckDuckGo when it returns results (no Bing call)", async () => {
    let bingCalled = false;
    mockFetch((url) => {
      if (url.includes("duckduckgo")) {
        return {
          ok: true,
          text: '<a class="result__a" href="//example.com/ddg">DDG Hit</a>',
        };
      }
      if (url.includes("bing.com")) bingCalled = true;
      return { ok: false, text: "" };
    });
    const out = await webSearchTool.call({ query: "test query" }, ctx);
    expect(out.output).toContain("DuckDuckGo");
    expect(out.output).toContain("DDG Hit");
    expect(bingCalled).toBe(false);
  });

  test("falls back to Bing when DuckDuckGo returns nothing", async () => {
    mockFetch((url) => {
      if (url.includes("duckduckgo")) return { ok: true, text: "<html></html>" };
      if (url.includes("bing.com")) {
        return {
          ok: true,
          text: '<li class="b_algo"><h2><a href="https://b.example/x">Bing Hit</a></h2><p>bing body</p></li>',
        };
      }
      return { ok: false, text: "" };
    });
    const out = await webSearchTool.call({ query: "test query" }, ctx);
    expect(out.output).toContain("Bing");
    expect(out.output).toContain("Bing Hit");
  });

  test("returns no-results message when both backends fail", async () => {
    mockFetch(() => ({ ok: false, text: "" }));
    const out = await webSearchTool.call({ query: "test query" }, ctx);
    expect(out.output).toContain("No search results");
  });

  test("rejects too-short queries", async () => {
    expect(webSearchTool.call({ query: "a" }, ctx)).rejects.toThrow();
  });
});
