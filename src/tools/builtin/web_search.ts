/** WebSearch tool — search the web via DuckDuckGo HTML. */

import { z } from "zod";

import { buildTool } from "../types.ts";

interface SearchResult {
  title: string;
  href: string;
  body: string;
}

async function searchDdgs(query: string, maxResults: number): Promise<SearchResult[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 wings/0.1",
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
  // DDG HTML format (classes changed over time):
  // <a rel="nofollow" class="result__a" href="...">title</a>
  // <a class="result__snippet" ...>snippet text</a>
  // Also try: <a class="result-link" href="..."> and <td class="result-snippet">
  const results: SearchResult[] = [];

  // Try multiple link patterns.
  let links: Array<{ href: string; title: string }> = [];
  for (const re of [
    /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g,
    /<a[^>]*class="[^"]*result-link[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g,
    /<a[^>]*rel="nofollow"[^>]*class="[^"]*result[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g,
  ]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      links.push({ href: m[1]!, title: stripTags(m[2]!) });
    }
    if (links.length > 0) break;
  }

  // Try multiple snippet patterns.
  let bodies: string[] = [];
  for (const re of [
    /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g,
    /<td[^>]*class="[^"]*result-snippet[^"]*"[^>]*>([\s\S]*?)<\/td>/g,
  ]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      bodies.push(stripTags(m[1]!));
    }
    if (bodies.length > 0) break;
  }

  for (let i = 0; i < Math.min(links.length, maxResults); i++) {
    results.push({
      title: links[i]!.title || "Untitled",
      href: decodeDdgHref(links[i]!.href),
      body: bodies[i] ?? "",
    });
  }

  // If no results from HTML parsing, return empty.
  return results;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'").replace(/&#39;/g, "'")
    .trim();
}

// -- Bing fallback ------------------------------------------------------------
// Mirrors src/wings/tools/builtin/bing_search.py: scrape cn.bing.com HTML
// results, parsing each <li class="b_algo"> into {title, href, body}.

const BING_URL = "https://cn.bing.com/search";
const BING_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

async function searchBing(query: string, maxResults: number): Promise<SearchResult[]> {
  // Up to 3 attempts with linear backoff (1s, 2s), matching the Python impl.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const url = `${BING_URL}?q=${encodeURIComponent(query)}&count=${maxResults}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { "User-Agent": BING_UA, Accept: "text/html" },
        redirect: "follow",
      });
      clearTimeout(timer);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const html = await response.text();
      return parseBingHtml(html, maxResults);
    } catch {
      if (attempt < 2) await sleep(1000 * (attempt + 1));
    }
  }
  return [];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function parseBingHtml(html: string, maxResults: number): SearchResult[] {
  // Each result is <li class="b_algo"> with an <h2><a href>title</a> and a <p> snippet.
  const results: SearchResult[] = [];
  const items = html.split(/<li[^>]*class="[^"]*b_algo[^"]*"[^>]*>/i).slice(1);
  for (const item of items) {
    if (results.length >= maxResults) break;
    // Title link: <h2>...<a href="...">title</a>...</h2> (or a.tilk fallback).
    const linkMatch =
      /<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(item) ??
      /<a[^>]*class="[^"]*tilk[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(item);
    if (!linkMatch) continue;
    const href = linkMatch[1]!;
    if (!href) continue;
    const title = stripTags(linkMatch[2]!).slice(0, 200) || "Untitled";
    // Snippet: first <p>...</p> after the link.
    const snippetMatch = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(item);
    const body = (snippetMatch ? stripTags(snippetMatch[1]!) : "")
      .replace(/&ensp;/g, " ").replace(/&#0183;/g, "")
      .slice(0, 500);
    results.push({ title, href, body });
  }
  return results;
}

function decodeDdgHref(href: string): string {
  const match = /uddg=([^&]+)/.exec(href);
  if (match) {
    try { return decodeURIComponent(match[1]!); } catch { return href; }
  }
  return href.startsWith("//") ? "https:" + href : href;
}

export const webSearchTool = buildTool({
  name: "web_search",
  description:
    "Allows web search and uses results to inform responses. " +
    "Provides up-to-date information for current events and recent data.",
  search_hint: "web_search query='search terms' max_results=5",
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
      // DuckDuckGo returned nothing (or was unreachable) — fall back to Bing.
      results = await searchBing(query, maxResults);
      backend = "Bing";
    }

    if (results.length === 0) {
      return [
        `No search results for '${query}'. Both DuckDuckGo and Bing may be unreachable.`,
        "",
        "Troubleshooting:",
        "- Try a broader or different query",
        "- Search engines may be unavailable in your region",
        "",
        "As an alternative, you can try:",
        "- web_fetch(url=\"https://www.google.com/search?q=...\") for structured results",
      ].join("\n");
    }

    const lines = [`Search: "${query}" — ${results.length} results (${backend})`, ""];
    for (let i = 0; i < results.length; i++) {
      const r = results[i]!;
      lines.push(`${i + 1}. [${r.title || "Untitled"}](${r.href})`);
      if (r.body) lines.push(`   ${r.body}`);
      lines.push("");
    }
    lines.push(
      "---\nSearch results are brief summaries. To read full content of any result, use web_fetch(url=\"<link>\") with the specific URL.",
    );
    return lines.join("\n");
  },
});
