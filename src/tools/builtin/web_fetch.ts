/** WebFetch tool — fetch a URL and return its content as markdown. */

import { convert } from "html-to-text";

import { z } from "zod";

import { buildTool } from "../types.ts";

// -- Limits (matching claude-code) --
const MAX_CONTENT_LENGTH = 10 * 1024 * 1024; // 10 MB
const MAX_MARKDOWN_LENGTH = 100_000; // 100K chars sent to model
const FETCH_TIMEOUT = 60; // seconds
const CACHE_TTL = 15 * 60 * 1000; // 15 minutes (ms)

// -- URL safety --
const BLOCKED_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "[::]"]);
const BLOCKED_CIDRS: RegExp[] = [
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./, // link-local
  /^127\./,
  /^0\./,
];

// -- Cache --
const cache = new Map<string, { ts: number; content: string }>();

function isBlockedHost(hostname: string): boolean {
  hostname = hostname.toLowerCase().replace(/\.$/, "");
  if (BLOCKED_HOSTS.has(hostname)) return true;
  if (hostname.startsWith("[")) return true; // IPv6, blocked
  for (const cidr of BLOCKED_CIDRS) {
    if (cidr.test(hostname)) return true;
  }
  return false;
}

function decodeContent(raw: Uint8Array): string | null {
  // Try UTF-8 first (covers most modern sites). Use TextDecoder with fatal:true
  // so invalid sequences cause an error, letting us fall back to other encodings.
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    // fall through
  }
  // Try Chinese encodings (common for financial/news sites).
  for (const enc of ["gb18030", "gbk", "big5", "gb2312"] as const) {
    try {
      return new (TextDecoder as any)(enc, { fatal: true }).decode(raw);
    } catch {
      continue;
    }
  }
  // Last resort: UTF-8 without fatal, then latin-1.
  try {
    return new TextDecoder("utf-8").decode(raw);
  } catch {
    try {
      return Buffer.from(raw).toString("latin1");
    } catch {
      return null;
    }
  }
}

function htmlToMarkdown(html: string): string {
  return convert(html, {
    wordwrap: 0,
    selectors: [
      { selector: "a", options: { hideLinkHrefIfSameAsText: true } },
      { selector: "img", format: "skip" as const },
    ],
  });
}

export const webFetchTool = buildTool({
  name: "web_fetch",
  description:
    "Fetches content from a specified URL and processes it. " +
    "Fetches the URL content, converts HTML to markdown. " +
    "Use this tool when you need to retrieve and analyze web content.\n" +
    "\n" +
    "Usage notes:\n" +
    "- The URL must be a fully-formed valid URL\n" +
    "- HTTP URLs will be automatically upgraded to HTTPS\n" +
    "- Results may be summarized if the content is very large\n" +
    "- Includes a 15-minute cache for repeated URLs\n" +
    "- When a URL redirects to a different host, make a new WebFetch request with the redirect URL.\n" +
    "- Many financial, news, and e-commerce sites return 403 (blocked). " +
    "If you get 403 from a domain, do NOT retry that same domain — the block " +
    "is intentional. Work with what you have from search snippets instead.",
  search_hint: "web_fetch url='https://docs.python.org/3/'",
  is_read_only: true,
  inputSchema: z.object({
    url: z.string().describe("The URL to fetch content from"),
    prompt: z.string().optional().describe("What information to extract from the page. If empty, returns the full page content."),
  }),
  async call(input) {
    let url = input.url.trim();
    if (!url) return "Error: URL is required";

    // Auto-upgrade HTTP to HTTPS
    if (url.startsWith("http://")) url = "https://" + url.slice(7);

    // Validate URL
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return `Error: invalid URL '${url}'`;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return `Error: unsupported protocol '${parsed.protocol.replace(":", "")}'`;
    }

    const hostname = parsed.hostname;
    if (isBlockedHost(hostname)) {
      return `Error: blocked host '${hostname}' (internal/private network)`;
    }

    // Check cache
    const cached = cache.get(url);
    if (cached && Date.now() - cached.ts < CACHE_TTL) {
      return cached.content;
    }

    // Fetch
    let response: Response;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT * 1000);
      response = await fetch(url, {
        signal: controller.signal,
        redirect: "follow",
        headers: {
          Accept: "text/markdown, text/html, text/plain, */*",
          "User-Agent": "wings/0.1",
        },
      });
      clearTimeout(timer);
    } catch (e) {
      if ((e as Error).name === "AbortError") {
        return `Error: request to '${url}' timed out after ${FETCH_TIMEOUT}s`;
      }
      return `Error: failed to fetch '${url}': ${(e as Error).message}`;
    }

    const status = response.status;
    const contentType = response.headers.get("content-type") ?? "";

    const raw = new Uint8Array(await response.arrayBuffer());
    if (raw.length > MAX_CONTENT_LENGTH) {
      return `Error: content too large (${raw.length} bytes, max ${MAX_CONTENT_LENGTH}). Try a more specific URL.`;
    }

    // Convert to text
    let text = decodeContent(raw);
    if (text === null) {
      return `Error: binary content (${raw.length} bytes, ${contentType})`;
    }

    // Convert HTML to markdown
    if (contentType.includes("text/html")) {
      try {
        text = htmlToMarkdown(text);
      } catch {
        // keep raw if conversion fails
      }
    }

    // Truncate
    if (text.length > MAX_MARKDOWN_LENGTH) {
      text = text.slice(0, MAX_MARKDOWN_LENGTH) +
        `\n\n[Content truncated: ${text.length - MAX_MARKDOWN_LENGTH} more chars]`;
    }

    const result = `Fetched ${raw.length} bytes\nStatus: ${status}\n\n${text}`;

    // Cache (simple LRU-ish: remove oldest if >100 entries)
    if (cache.size > 100) {
      const oldest = [...cache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
      if (oldest) cache.delete(oldest[0]);
    }
    cache.set(url, { ts: Date.now(), content: result });

    return result;
  },
});
