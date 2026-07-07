/** WebSearch tool — search the web via DuckDuckGo HTML scraping. */

import { z } from "zod";

import { buildTool } from "../types.ts";

interface SearchResult {
  title: string;
  href: string;
  body: string;
}

/** Search via DuckDuckGo HTML endpoint (no API key required). */
async function searchDdgs(query: string, maxResults: number): Promise<SearchResult[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) wings/0.1",
        Accept: "text/html",
      },
    });
    clearTimeout(timer);
    if (!response.ok) return [];
    const html = await response.text();
    return parseDdgsHtml(html, maxResults);
  } catch {
    return [];
  }
}

function parseDdgsHtml(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = [];
  // DuckDuckGo HTML results: <a class="result__a" href="...">title</a>
  // and <a class="result__snippet" ...>body</a>
  const linkRegex = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRegex = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  const titles: Array<{ href: string; title: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = linkRegex.exec(html)) !== null) {
    titles.push({ href: m[1]!, title: stripTags(m[2]!) });
  }
  const bodies: string[] = [];
  while ((m = snippetRegex.exec(html)) !== null) {
    bodies.push(stripTags(m[1]!));
  }
  for (let i = 0; i < Math.min(titles.length, maxResults); i++) {
    results.push({
      title: titles[i]!.title,
      href: decodeDdgHref(titles[i]!.href),
      body: bodies[i] ?? "",
    });
  }
  return results;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").trim();
}

function decodeDdgHref(href: string): string {
  // DDG wraps links as //duckduckgo.com/l/?uddg=<encoded>
  const match = /uddg=([^&]+)/.exec(href);
  if (match) {
    try {
      return decodeURIComponent(match[1]!);
    } catch {
      return href;
    }
  }
  return href.startsWith("//") ? "https:" + href : href;
}

export const webSearchTool = buildTool({
  name: "web_search",
  description:
    "Allows Claude to search the web and use the results to inform responses. " +
    "Provides up-to-date information for current events and recent data.",
  search_hint: "web_search query='python documentation' max_results=5",
  is_read_only: true,
  inputSchema: z.object({
    query: z.string().min(2).describe("The search query to use"),
    max_results: z.number().int().min(1).max(20).optional().describe("Maximum number of results to return (1-20)"),
  }),
  async call(input) {
    const query = input.query.trim();
    if (query.length < 2) {
      return "Error: search query must be at least 2 characters";
    }
    const maxResults = input.max_results ?? 10;

    let results = await searchDdgs(query, maxResults);
    let backend = "DuckDuckGo";
    if (results.length === 0) {
      // No Bing fallback implemented yet in TS rewrite — DDG only.
      backend = "DuckDuckGo (no results)";
    }

    if (results.length === 0) {
      return `No results found for '${query}'. Try a broader or different query.`;
    }

    const lines = [`Search: "${query}" — ${results.length} results (${backend})`, ""];
    for (let i = 0; i < results.length; i++) {
      const r = results[i]!;
      const title = r.title || "Untitled";
      lines.push(`${i + 1}. [${title}](${r.href})`);
      if (r.body) lines.push(`   ${r.body}`);
      lines.push("");
    }
    lines.push(
      "---\nSearch results are brief summaries. To read full content of any result, use web_fetch(url=\"<link>\") with the specific URL.",
    );
    return lines.join("\n");
  },
});
