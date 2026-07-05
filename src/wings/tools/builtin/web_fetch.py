"""WebFetch tool — fetch a URL and process it through a lightweight model.

Follows claude-code's WebFetchTool design:
- httpx for HTTP with markdown preference (Accept header)
- html2text for HTML → Markdown conversion
- 15-min LRU cache by URL
- Domain safety: blocked internal/private IPs
- Content truncated to 100K chars
"""

from __future__ import annotations

import re
import time
from typing import Any
from urllib.parse import urlparse

import html2text
import httpx
from pydantic import BaseModel, Field

from wings.tools.base import ToolContext, ToolResult
from wings.tools.decorator import tool

# -- Limits (matching claude-code) --

_MAX_CONTENT_LENGTH = 10 * 1024 * 1024  # 10 MB
_MAX_MARKDOWN_LENGTH = 100_000  # 100K chars sent to model
_FETCH_TIMEOUT = 60  # seconds
_MAX_REDIRECTS = 10
_CACHE_TTL = 15 * 60  # 15 minutes

# -- URL safety --

# Block private/internal IP ranges and local hostnames
_BLOCKED_HOSTS = frozenset({"localhost", "127.0.0.1", "0.0.0.0", "[::1]", "[::]"})
_BLOCKED_CIDRS = (
    re.compile(r"^10\."),
    re.compile(r"^172\.(1[6-9]|2\d|3[01])\."),
    re.compile(r"^192\.168\."),
    re.compile(r"^169\.254\."),  # link-local
    re.compile(r"^127\."),
    re.compile(r"^0\."),
)

# -- Cache --

_cache: dict[str, tuple[float, str]] = {}


def _is_blocked_host(hostname: str) -> bool:
    """Check if hostname targets an internal/private network."""
    hostname = hostname.lower().rstrip(".")
    if hostname in _BLOCKED_HOSTS:
        return True
    if hostname.startswith("["):
        return True  # IPv6, blocked
    for cidr in _BLOCKED_CIDRS:
        if cidr.match(hostname):
            return True
    return False


def _html_to_markdown(html: str, base_url: str) -> str:
    """Convert HTML to markdown using html2text."""
    h = html2text.HTML2Text()
    h.body_width = 0  # don't wrap lines
    h.ignore_links = False
    h.ignore_images = True
    h.ignore_emphasis = False
    h.baseurl = base_url
    return h.handle(html)


def _check_cache(url: str) -> str | None:
    """Return cached content if not expired."""
    entry = _cache.get(url)
    if entry is None:
        return None
    ts, content = entry
    if time.monotonic() - ts > _CACHE_TTL:
        del _cache[url]
        return None
    return content


def _set_cache(url: str, content: str) -> None:
    """Store content in cache. Simple LRU-ish: remove oldest if >100 entries."""
    if len(_cache) > 100:
        oldest = min(_cache.keys(), key=lambda k: _cache[k][0])
        del _cache[oldest]
    _cache[url] = (time.monotonic(), content)


def _decode_content(raw: bytes) -> str | None:
    """Try to decode bytes to text with encoding fallback chain.

    UTF-8 first, then common Chinese encodings (GBK, GB18030, Big5).
    Returns None if all decoders fail (likely binary content).
    """
    # Try UTF-8 first (covers most modern sites)
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        pass

    # Try Chinese encodings (Sina Finance, East Money, etc.)
    for enc in ("gb18030", "gbk", "big5", "gb2312"):
        try:
            return raw.decode(enc)
        except (UnicodeDecodeError, LookupError):
            continue

    # Last resort: latin-1 never fails, but may produce garbage
    try:
        return raw.decode("latin-1")
    except Exception:
        return None


class WebFetchInput(BaseModel):
    """Input schema for web_fetch tool."""

    url: str = Field(description="The URL to fetch content from")
    prompt: str = Field(
        default="",
        description="What information to extract from the page. If empty, returns the full page content.",
    )


@tool(
    name="web_fetch",
    description=(
        "Fetches content from a specified URL and processes it. "
        "Fetches the URL content, converts HTML to markdown. "
        "Use this tool when you need to retrieve and analyze web content.\n"
        "\n"
        "Usage notes:\n"
        "- The URL must be a fully-formed valid URL\n"
        "- HTTP URLs will be automatically upgraded to HTTPS\n"
        "- Results may be summarized if the content is very large\n"
        "- Includes a 15-minute cache for repeated URLs\n"
        "- When a URL redirects to a different host, make a new WebFetch request "
        "with the redirect URL.\n"
        "- Many financial, news, and e-commerce sites return 403 (blocked). "
        "If you get 403 from a domain, do NOT retry that same domain — the block "
        "is intentional. Work with what you have from search snippets instead."
    ),
    read_only=True,
    search_hint="web_fetch url='https://docs.python.org/3/'",
)
async def web_fetch(input: WebFetchInput, context: ToolContext) -> str:
    """Fetch a URL and return its content as markdown."""
    url = input.url.strip()
    if not url:
        return "Error: URL is required"

    # Auto-upgrade HTTP to HTTPS
    if url.startswith("http://"):
        url = "https://" + url[7:]

    # Validate URL
    try:
        parsed = urlparse(url)
        if not parsed.scheme or not parsed.netloc:
            return f"Error: invalid URL '{url}'"
        if parsed.scheme not in ("http", "https"):
            return f"Error: unsupported protocol '{parsed.scheme}'"
    except Exception:
        return f"Error: could not parse URL '{url}'"

    hostname = parsed.hostname or ""
    if _is_blocked_host(hostname):
        return f"Error: blocked host '{hostname}' (internal/private network)"

    # Check cache
    cached = _check_cache(url)
    if cached is not None:
        return cached

    # Fetch
    async with httpx.AsyncClient(
        timeout=_FETCH_TIMEOUT,
        follow_redirects=True,
        max_redirects=_MAX_REDIRECTS,
        headers={
            "Accept": "text/markdown, text/html, text/plain, */*",
            "User-Agent": "wings/0.1",
        },
    ) as client:
        try:
            response = await client.get(url)
        except httpx.TimeoutException:
            return f"Error: request to '{url}' timed out after {_FETCH_TIMEOUT}s"
        except httpx.TooManyRedirects:
            return f"Error: too many redirects for '{url}'"
        except httpx.RequestError as e:
            return f"Error: failed to fetch '{url}': {e}"

        status = response.status_code
        content_type = response.headers.get("content-type", "")

        # Read content, limiting to max size
        raw = response.read()
        if len(raw) > _MAX_CONTENT_LENGTH:
            return (
                f"Error: content too large ({len(raw)} bytes, max {_MAX_CONTENT_LENGTH}). "
                f"Try a more specific URL."
            )

    # Convert to text — try UTF-8 first, fall back to common Chinese encodings
    text = _decode_content(raw)
    if text is None:
        return f"Error: binary content ({len(raw)} bytes, {content_type})"

    # Convert HTML to markdown
    if "text/html" in content_type:
        try:
            text = _html_to_markdown(text, url)
        except Exception:
            pass  # keep raw if conversion fails

    # Truncate
    if len(text) > _MAX_MARKDOWN_LENGTH:
        text = text[:_MAX_MARKDOWN_LENGTH] + (
            f"\n\n[Content truncated: {len(text) - _MAX_MARKDOWN_LENGTH} more chars]"
        )

    result = f"Fetched {len(raw)} bytes\nStatus: {status}\n\n{text}"

    # Cache
    _set_cache(url, result)

    return result
