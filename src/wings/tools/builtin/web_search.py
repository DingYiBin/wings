"""WebSearch tool — search the web via DuckDuckGo (primary) or Bing (fallback)."""

from __future__ import annotations

from pydantic import BaseModel, Field

from wings.tools.base import ToolContext
from wings.tools.decorator import tool


class WebSearchInput(BaseModel):
    """Input schema for web_search tool."""

    query: str = Field(
        min_length=2,
        description="The search query to use",
    )
    max_results: int = Field(
        default=10,
        ge=1,
        le=20,
        description="Maximum number of results to return (1-20)",
    )


def _search_ddgs(query: str, max_results: int) -> list[dict[str, str]]:
    """Search via DuckDuckGo (primary backend)."""
    try:
        from ddgs import DDGS

        with DDGS() as ddgs:
            raw = list(ddgs.text(query, max_results=max_results))
        return [
            {"title": r.get("title", ""), "href": r.get("href", ""), "body": r.get("body", "")}
            for r in raw
        ]
    except Exception:
        return []


def _search_bing(query: str, max_results: int) -> list[dict[str, str]]:
    """Search via Bing (fallback)."""
    from wings.tools.builtin.bing_search import bing_search

    return bing_search(query, max_results)


@tool(
    name="web_search",
    description=(
        "Allows Claude to search the web and use the results to inform responses.\n"
        "- Provides up-to-date information for current events and recent data\n"
        "- Returns search result information formatted as search result blocks\n"
        "- Use this tool for accessing information beyond Claude's knowledge cutoff\n"
        "\n"
        "CRITICAL REQUIREMENT - You MUST follow this:\n"
        "  - After answering the user's question, you MUST include a \"Sources:\" "
        "section at the end of your response\n"
        "  - In the Sources section, list all relevant URLs from the search results "
        "as markdown hyperlinks: [Title](URL)\n"
        "  - This is MANDATORY - never skip including sources in your response\n"
        "\n"
        "Usage notes:\n"
        "  - Search snippets often contain the answer (numbers, dates, facts). "
        "If the snippet already has what you need, answer directly — do NOT "
        "call web_fetch on every result. Only fetch when the snippet is "
        "insufficient.\n"
        "  - If your first 1-2 web_fetch calls return 403 errors, STOP "
        "fetching. Many sites block automated access. Work with the snippets "
        "you already have.\n"
        "  - For time-sensitive queries, 2-3 search attempts are usually enough. "
        "Answer with what you have rather than searching indefinitely.\n"
        "\n"
        "IMPORTANT - Use the correct year in search queries:\n"
        "  - The current month is July 2026. You MUST use this year when searching "
        "for recent information, documentation, or current events."
    ),
    read_only=True,
    search_hint="web_search query='python documentation' max_results=5",
)
async def web_search(input: WebSearchInput, context: ToolContext) -> str:
    """Search the web and return formatted results."""
    query = input.query.strip()
    if len(query) < 2:
        return "Error: search query must be at least 2 characters"

    # Try DuckDuckGo first, fall back to Bing
    try:
        results = _search_ddgs(query, input.max_results)
    except Exception:
        results = []
    backend = "DuckDuckGo"
    if not results:
        results = _search_bing(query, input.max_results)
        backend = "Bing"

    if not results:
        return f"No results found for '{query}'. Try a broader or different query."

    lines = [
        f'Search: "{query}" — {len(results)} results ({backend})',
        "",
    ]
    for i, r in enumerate(results, 1):
        title = r.get("title", "") or "Untitled"
        href = r.get("href", "")
        body = r.get("body", "")
        lines.append(f"{i}. [{title}]({href})")
        if body:
            lines.append(f"   {body}")
        lines.append("")

    lines.append(
        "---\n"
        "Search results are brief summaries. To read full content of any "
        "result, use web_fetch(url=\"<link>\") with the specific URL."
    )
    return "\n".join(lines)
